import { config } from '../config';
import { PoolStats, MarketSnapshot, PositionRecord, RiskAnalysis, FullReportSnapshot } from '../types';
import { getTokenPrices } from '../market/TokenPriceService';
import {
    buildTelegramPositionBlock,
    buildSummaryBlock,
    buildPoolRankingBlock,
    buildTimestampBlock,
    buildFlashReport,
    FlashAlert,
    PoolRankingRow,
} from './formatter';
import { normalizeRawAmount, calculateCapitalEfficiency } from '../infra/utils/math';
import { TOKEN_DECIMALS } from '../infra/utils/tokenInfo';
import { appState } from '../infra/AppState';
import { isValidWalletAddress } from '../infra/utils/validation';

// ── 快訊 snapshot（每次送快訊後更新，不持久化）──────────────────────────────
// key = tokenId, value = unclaimedFeesUSD at last flash
const flashSnapshot = new Map<string, number>();
let lastFlashSnapshotTime = 0;

// ── 完整報告 snapshot（每次送完整報告後更新，不持久化）─────────────────────
const fullReportSnapshot = new Map<string, FullReportSnapshot>();

// ── sendFlashReport ───────────────────────────────────────────────────────────
export async function sendFlashReport(
    sendAlert: (msg: string) => Promise<void>,
    positions: PositionRecord[]
): Promise<void> {
    const now = Date.now();

    // 總覽
    const totalPositionUSD = positions.reduce((s, p) => s + p.positionValueUSD, 0);
    const totalUnclaimedUSD = positions.reduce((s, p) => s + p.unclaimedFeesUSD, 0);
    const totalInitialCapital = positions.reduce((s, p) => s + (p.initialCapital ?? 0), 0);
    const pnlValues = positions.map(p => p.ilUSD);
    const totalPnL = pnlValues.every(v => v !== null) ? pnlValues.reduce((s, v) => s + (v ?? 0), 0) : null;
    const totalPnLPct = totalPnL !== null && totalInitialCapital > 0 ? (totalPnL / totalInitialCapital) * 100 : null;

    // 本週期手續費 Δ
    let deltaAmount = 0;
    let hasDelta = false;
    if (lastFlashSnapshotTime > 0) {
        for (const pos of positions) {
            const prev = flashSnapshot.get(pos.tokenId);
            if (prev !== undefined) { deltaAmount += pos.unclaimedFeesUSD - prev; hasDelta = true; }
        }
    }

    // 各幣種持倉加總（含 token2）
    const tp = getTokenPrices();
    const tokenPriceMap: Record<string, number> = {
        'WETH': tp.ethPrice, 'ETH': tp.ethPrice,
        'cbBTC': tp.cbbtcPrice, 'WBTC': tp.cbbtcPrice,
        'CAKE': tp.cakePrice, 'AERO': tp.aeroPrice,
        'USDC': 1, 'USDbC': 1, 'USDT': 1, 'DAI': 1,
    };
    const tokenTotals = new Map<string, number>();
    for (const pos of positions) {
        tokenTotals.set(pos.token0Symbol, (tokenTotals.get(pos.token0Symbol) ?? 0) + pos.amount0);
        tokenTotals.set(pos.token1Symbol, (tokenTotals.get(pos.token1Symbol) ?? 0) + pos.amount1);
        if (pos.token2Symbol && pos.unclaimed2) {
            const amt2 = normalizeRawAmount(pos.unclaimed2, TOKEN_DECIMALS[pos.token2Symbol] ?? 18);
            if (amt2 > 0) tokenTotals.set(pos.token2Symbol, (tokenTotals.get(pos.token2Symbol) ?? 0) + amt2);
        }
    }
    const holdings = [...tokenTotals.entries()]
        .filter(([, amt]) => amt > 0)
        .map(([symbol, amount]) => ({ symbol, amount, usdValue: (tokenPriceMap[symbol] ?? 0) * amount }))
        .sort((a, b) => b.usdValue - a.usdValue);

    // Alerts（優先序：穿倉 > RED_ALERT > DRIFT > HIGH_VOL > 複利）
    const alerts: FlashAlert[] = [];
    for (const pos of positions)
        if (pos.currentTick < pos.tickLower || pos.currentTick > pos.tickUpper)
            alerts.push({ type: 'outOfRange', tokenId: pos.tokenId });
    for (const pos of positions)
        if (pos.riskAnalysis?.redAlert)
            alerts.push({ type: 'redAlert', tokenId: pos.tokenId });
    for (const pos of positions)
        if (pos.riskAnalysis?.driftWarning)
            alerts.push({ type: 'drift', tokenId: pos.tokenId, overlapPct: pos.riskAnalysis.driftOverlapPct });
    for (const pos of positions)
        if (pos.riskAnalysis?.highVolatilityAvoid)
            alerts.push({ type: 'highVol', tokenId: pos.tokenId });
    for (const pos of positions)
        if (pos.riskAnalysis?.compoundSignal)
            alerts.push({ type: 'compound', tokenId: pos.tokenId, unclaimedUSD: pos.unclaimedFeesUSD });

    const prevFlashSnapshotTime = lastFlashSnapshotTime;
    for (const pos of positions) flashSnapshot.set(pos.tokenId, pos.unclaimedFeesUSD);
    lastFlashSnapshotTime = now;

    await sendAlert(buildFlashReport({
        nowTs: now,
        tp,
        totalPositionUSD,
        totalUnclaimedUSD,
        totalPnL,
        totalPnLPct,
        holdings,
        deltaFees: hasDelta ? { amount: deltaAmount, prevSnapshotTs: prevFlashSnapshotTime } : null,
        alerts,
    }));
}

// ── sendConsolidatedReport ────────────────────────────────────────────────────
export async function sendConsolidatedReport(
    sendAlert: (msg: string) => Promise<void>,
    entries: Array<{ position: PositionRecord; pool: PoolStats; bb: MarketSnapshot | null; risk: RiskAnalysis }>,
    allPools: PoolStats[],
    lastUpdates: { cycleAt: number }
): Promise<void> {
    const timeFormatter = new Intl.DateTimeFormat('zh-TW', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
        timeZone: 'Asia/Taipei',
    });
    const reportTimeStr = timeFormatter.format(new Date()).replace(/\//g, '-').replace(',', '');

    // 依當前排序鍵由大到小排列
    const sortBy = appState.userConfig.sortBy ?? 'size';
    const sorted = [...entries].sort((a, b) => {
        switch (sortBy) {
            case 'apr': return b.pool.apr - a.pool.apr;
            case 'unclaimed': return b.position.unclaimedFeesUSD - a.position.unclaimedFeesUSD;
            case 'health': return b.risk.healthScore - a.risk.healthScore;
            case 'size':
            default: return b.position.positionValueUSD - a.position.positionValueUSD;
        }
    });

    // ── 總覽計算 ──────────────────────────────────────────────
    const totalPositionUSD = entries.reduce((s, e) => s + e.position.positionValueUSD, 0);
    const totalUnclaimedUSD = entries.reduce((s, e) => s + e.position.unclaimedFeesUSD, 0);
    const totalInitialCapital = entries.reduce((s, e) => s + (e.position.initialCapital ?? 0), 0);
    const pnlValues = entries.map(e => e.position.ilUSD);
    const totalPnL = pnlValues.every(v => v !== null)
        ? pnlValues.reduce((s, v) => s + (v ?? 0), 0) : null;
    const totalPnLPct = (totalPnL !== null && totalInitialCapital > 0)
        ? (totalPnL / totalInitialCapital) * 100 : null;
    const walletCount = new Set(
        entries.map(e => e.position.ownerWallet).filter(w => isValidWalletAddress(w))
    ).size;
    const hasFullReportSnapshot = fullReportSnapshot.size > 0;
    let overallDelta: { dPos: number; dUncl: number; dIl: number | null } | undefined;
    if (hasFullReportSnapshot) {
        let dPos = 0, dUncl = 0, dIl = 0, count = 0;
        for (const { position } of entries) {
            const prev = fullReportSnapshot.get(position.tokenId);
            if (prev) {
                dPos += position.positionValueUSD - prev.positionValueUSD;
                dUncl += position.unclaimedFeesUSD - prev.unclaimedFeesUSD;
                if (position.ilUSD !== null && prev.ilUSD !== null) dIl += position.ilUSD - prev.ilUSD;
                count++;
            }
        }
        if (count > 0) overallDelta = { dPos, dUncl, dIl: dIl !== 0 ? dIl : null };
    }

    // ── 總覽區塊 ──────────────────────────────────────────────
    let msg = buildSummaryBlock({
        reportTimeStr,
        positionCount: sorted.length,
        sortLabel: config.SORT_LABELS[sortBy],
        walletCount,
        totalPositionUSD,
        totalInitialCapital,
        totalUnclaimedUSD,
        tp: getTokenPrices(),
        totalPnL,
        totalPnLPct,
        overallDelta,
    });

    // ── 各倉位區塊 ────────────────────────────────────────────
    const compact = appState.userConfig.compactMode ?? false;
    for (let i = 0; i < sorted.length; i++) {
        const { position, pool, bb, risk } = sorted[i];
        const prev = hasFullReportSnapshot ? fullReportSnapshot.get(position.tokenId) : undefined;
        let diff: { dPos: number; dUncl: number; dIl: number | null } | undefined;
        if (prev) {
            diff = {
                dPos: position.positionValueUSD - prev.positionValueUSD,
                dUncl: position.unclaimedFeesUSD - prev.unclaimedFeesUSD,
                dIl: (position.ilUSD !== null && prev.ilUSD !== null) ? position.ilUSD - prev.ilUSD : null,
            };
        }
        msg += buildTelegramPositionBlock(i + 1, position, pool, bb, risk, compact, diff);
    }

    // ── 池排行 ────────────────────────────────────────────────
    if (allPools.length > 0) {
        const medals = ['🥇', '🥈', '🥉'];
        const activePoolIds = new Set(entries.map(e => e.position.poolAddress.toLowerCase()));

        const rows: PoolRankingRow[] = allPools.map((p, i) => {
            const isMyPool = activePoolIds.has(p.id.toLowerCase());
            const totalApr = p.apr + (p.farmApr ?? 0);

            // 區間 APR
            let inRangeApr: number | null = null;
            const bb = appState.marketSnapshots[p.id.toLowerCase()];
            if (bb && !bb.isFallback && bb.sma > 0) {
                const eff = calculateCapitalEfficiency(bb.upperPrice, bb.lowerPrice, bb.sma);
                if (eff !== null) inRangeApr = totalApr * eff;
            }

            // 移倉回本天數
            let migrationPaybackDays: number | null = null;
            if (isMyPool) {
                const myEntry = entries.find(e => e.position.poolAddress.toLowerCase() === p.id.toLowerCase());
                if (myEntry && myEntry.position.positionValueUSD > 0) {
                    const bestAlt = allPools
                        .filter(alt => alt.id.toLowerCase() !== p.id.toLowerCase())
                        .sort((a, b) => (b.apr + (b.farmApr ?? 0)) - (a.apr + (a.farmApr ?? 0)))[0];
                    if (bestAlt) {
                        const aprDiff = (bestAlt.apr + (bestAlt.farmApr ?? 0)) - totalApr;
                        if (aprDiff > 0) {
                            const dailyExtraIncome = myEntry.position.positionValueUSD * aprDiff / 365;
                            const paybackDays = Math.ceil(1 / dailyExtraIncome); // gasCostUSD ≈ $1
                            if (paybackDays <= 30) migrationPaybackDays = paybackDays;
                        }
                    }
                }
            }

            return { rank: medals[i] ?? '　', dex: p.dex, feeTier: p.feeTier, apr: p.apr, farmApr: p.farmApr, tvlUSD: p.tvlUSD, isMyPool, inRangeApr, migrationPaybackDays };
        });

        msg += buildPoolRankingBlock(rows);
    }

    // ── 更新時間 + BB k 值 ────────────────────────────────────
    msg += buildTimestampBlock(lastUpdates, appState.marketKLowVol, appState.marketKHighVol);

    // 更新 fullReportSnapshot
    for (const { position } of entries) {
        fullReportSnapshot.set(position.tokenId, {
            positionValueUSD: position.positionValueUSD,
            unclaimedFeesUSD: position.unclaimedFeesUSD,
            ilUSD: position.ilUSD,
        });
    }

    await sendAlert(msg);
}
