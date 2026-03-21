import { config } from '../config';
import { PoolStats, BBResult, PositionRecord, RiskAnalysis, FullReportSnapshot } from '../types';
import { getTokenPrices } from '../utils/tokenPrices';
import { buildTelegramPositionBlock, buildTokenPriceLine, fmtDeltaUSD, compactAmount } from '../utils/formatter';
import { normalizeRawAmount } from '../utils/math';
import { TOKEN_DECIMALS } from '../utils/tokenInfo';
import { appState } from '../utils/AppState';
import { isValidWalletAddress } from '../utils/validation';
import { calculateCapitalEfficiency } from '../utils/math';

const FMT = config.FMT;

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
    const timeOnlyFormatter = new Intl.DateTimeFormat('zh-TW', {
        hour: '2-digit', minute: '2-digit', hour12: false,
        timeZone: 'Asia/Taipei',
    });
    const now = Date.now();
    const timeStr = timeOnlyFormatter.format(new Date(now));

    // 組合總覽
    const totalPositionUSD = positions.reduce((s, pos) => s + pos.positionValueUSD, 0);
    const totalUnclaimedUSD = positions.reduce((s, pos) => s + pos.unclaimedFeesUSD, 0);
    const totalInitialCapital = positions.reduce((s, pos) => s + (pos.initialCapital ?? 0), 0);
    const pnlValues = positions.map(pos => pos.ilUSD);
    const totalPnL = pnlValues.every(v => v !== null)
        ? pnlValues.reduce((s, v) => s + (v ?? 0), 0) : null;
    const totalPnLPct = (totalPnL !== null && totalInitialCapital > 0)
        ? (totalPnL / totalInitialCapital) * 100 : null;

    // 本週期新增手續費（Δ unclaimedFeesUSD vs 上次快訊 snapshot）
    let deltaUnclaimedTotal = 0;
    let hasDelta = false;
    if (lastFlashSnapshotTime > 0) {
        for (const pos of positions) {
            const prev = flashSnapshot.get(pos.tokenId);
            if (prev !== undefined) {
                deltaUnclaimedTotal += pos.unclaimedFeesUSD - prev;
                hasDelta = true;
            }
        }
    }

    const tp = getTokenPrices();
    // 已知幣種價格表（USDC 系穩定幣視為 $1）
    const tokenPriceMap: Record<string, number> = {
        'WETH': tp.ethPrice, 'ETH': tp.ethPrice,
        'cbBTC': tp.cbbtcPrice, 'WBTC': tp.cbbtcPrice,
        'CAKE': tp.cakePrice, 'AERO': tp.aeroPrice,
        'USDC': 1, 'USDbC': 1, 'USDT': 1, 'DAI': 1,
    };

    let msg = `📡 <b>[${timeStr}] 快訊</b>`;
    msg += `\n${buildTokenPriceLine(tp)}`;
    msg += `\n💼 總倉位 <b>$${totalPositionUSD.toFixed(FMT.USD_WHOLE)}</b>  未領取 <b>$${totalUnclaimedUSD.toFixed(FMT.USD_CENTS)}</b>`;

    if (totalPnL !== null) {
        const icon = totalPnL >= 0 ? '🟢' : '🔴';
        const pctStr = totalPnLPct !== null
            ? ` (${totalPnLPct >= 0 ? '+' : ''}${totalPnLPct.toFixed(FMT.PCT_HUNDREDTH)}%)`
            : '';
        msg += `\n💰 獲利 <b>${fmtDeltaUSD(totalPnL)}${pctStr}</b> ${icon}`;
    }

    // 各幣種持倉加總，兩欄每排格式：
    //   🪙  8800U
    //      0.823 WETH(1778U) | 0.0₃412 cbBTC(2905U)
    //      1234 USDC(1234U)
    const tokenTotals = new Map<string, number>();
    for (const pos of positions) {
        tokenTotals.set(pos.token0Symbol, (tokenTotals.get(pos.token0Symbol) ?? 0) + pos.amount0);
        tokenTotals.set(pos.token1Symbol, (tokenTotals.get(pos.token1Symbol) ?? 0) + pos.amount1);
        if (pos.token2Symbol && pos.unclaimed2) {
            const dec2 = TOKEN_DECIMALS[pos.token2Symbol] ?? 18;
            const amt2 = normalizeRawAmount(pos.unclaimed2, dec2);
            if (amt2 > 0) {
                tokenTotals.set(pos.token2Symbol, (tokenTotals.get(pos.token2Symbol) ?? 0) + amt2);
            }
        }
    }
    const holdingParts = [...tokenTotals.entries()]
        .filter(([, amt]) => amt > 0)
        .map(([sym, amt]) => {
            const price = tokenPriceMap[sym];
            const usd = price ? amt * price : 0;
            const usdStr = price ? `(${Math.round(usd)}U)` : '';
            return { label: `${compactAmount(amt)} ${sym}${usdStr}`, usd };
        })
        .sort((a, b) => b.usd - a.usd)
        .map(({ label }) => label);
    if (holdingParts.length > 0) {
        msg += `\n🪙  ${Math.round(totalPositionUSD)}U`;
        for (let i = 0; i < holdingParts.length; i += 2) {
            const pair = holdingParts[i + 1]
                ? `${holdingParts[i]} | ${holdingParts[i + 1]}`
                : holdingParts[i];
            msg += `\n   ${pair}`;
        }
    }

    if (hasDelta) {
        const snapshotTimeStr = timeOnlyFormatter.format(new Date(lastFlashSnapshotTime));
        msg += `\n📈 本週期手續費 <b>${fmtDeltaUSD(deltaUnclaimedTotal)}</b> (vs ${snapshotTimeStr})`;
    }

    // 異常倉位（穿倉 + 可複利）
    const alerts: string[] = [];
    for (const pos of positions) {
        if (pos.currentTick < pos.tickLower || pos.currentTick > pos.tickUpper) {
            alerts.push(`⚠️ #${pos.tokenId} 穿倉`);
        }
    }
    for (const pos of positions) {
        if (pos.riskAnalysis?.compoundSignal === true) {
            alerts.push(`✅ #${pos.tokenId} 可複利 $${pos.unclaimedFeesUSD.toFixed(FMT.USD_TENTH)}`);
        }
    }
    if (alerts.length > 0) {
        msg += `\n${alerts.join('\n')}`;
    }

    // 更新 flashSnapshot
    for (const pos of positions) {
        flashSnapshot.set(pos.tokenId, pos.unclaimedFeesUSD);
    }
    lastFlashSnapshotTime = now;

    await sendAlert(msg);
}

// ── sendConsolidatedReport ────────────────────────────────────────────────────
export async function sendConsolidatedReport(
    sendAlert: (msg: string) => Promise<void>,
    entries: Array<{ position: PositionRecord; pool: PoolStats; bb: BBResult | null; risk: RiskAnalysis }>,
    allPools: PoolStats[],
    lastUpdates: { poolScanner: number; positionScanner: number; bbEngine: number; riskManager: number }
): Promise<void> {
    const timeFormatter = new Intl.DateTimeFormat('zh-TW', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
        timeZone: 'Asia/Taipei',
    });
    const timeOnlyFormatter = new Intl.DateTimeFormat('zh-TW', {
        hour: '2-digit', minute: '2-digit', hour12: false,
        timeZone: 'Asia/Taipei',
    });
    const timeStr = timeFormatter.format(new Date()).replace(/\//g, '-').replace(',', '');
    // 使用獨立的 time-only formatter 避免 zh-TW locale 在新版 ICU 使用 U+202F
    // 而非一般空格導致 split(' ') 回傳 undefined
    const formatTs = (ts: number) => ts === 0 ? '無紀錄' : timeOnlyFormatter.format(new Date(ts));

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

    // ── 總覽區塊 ──────────────────────────────────────────────
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
    const fmtUSD = (v: number) => fmtDeltaUSD(v, FMT.USD_TENTH);

    // ── 完整報告 Δ 總覽（vs 上次完整報告 snapshot）───────────
    const hasFullReportSnapshot = fullReportSnapshot.size > 0;
    let fullReportDeltaPosUSD = 0;
    let fullReportDeltaUnclaimedUSD = 0;
    let fullReportDeltaIlUSD = 0;
    let fullReportDeltaCount = 0;
    if (hasFullReportSnapshot) {
        for (const { position } of entries) {
            const prev = fullReportSnapshot.get(position.tokenId);
            if (prev) {
                fullReportDeltaPosUSD += position.positionValueUSD - prev.positionValueUSD;
                fullReportDeltaUnclaimedUSD += position.unclaimedFeesUSD - prev.unclaimedFeesUSD;
                if (position.ilUSD !== null && prev.ilUSD !== null) {
                    fullReportDeltaIlUSD += position.ilUSD - prev.ilUSD;
                }
                fullReportDeltaCount++;
            }
        }
    }

    let msg = `<b>[${timeStr}] 倉位監控報告 (${sorted.length} 個倉位 | 排序: ${config.SORT_LABELS[sortBy]} ↓)</b>`;
    msg += `\n\n📊 <b>總覽</b>  ${entries.length} 倉位 · ${walletCount} 錢包`;
    msg += `\n💼 總倉位 <b>$${totalPositionUSD.toFixed(FMT.USD_WHOLE)}</b>  |  本金 <b>$${totalInitialCapital.toFixed(FMT.USD_WHOLE)}</b>  |  未領取 <b>$${totalUnclaimedUSD.toFixed(FMT.USD_CENTS)}</b>`;
    msg += `\n${buildTokenPriceLine(getTokenPrices())}`;

    if (totalPnL !== null) {
        const icon = totalPnL >= 0 ? '🟢' : '🔴';
        const pctStr = totalPnLPct !== null
            ? ` (${totalPnLPct >= 0 ? '+' : ''}${totalPnLPct.toFixed(FMT.PCT_HUNDREDTH)}%)`
            : '';
        msg += `\n💰 總獲利 <b>${fmtUSD(totalPnL)}${pctStr}</b> ${icon}`;
    }

    // 完整報告差異總覽
    if (hasFullReportSnapshot && fullReportDeltaCount > 0) {
        msg += `\n📅 <b>完整報告差異</b>`;
        msg += `  倉位 ${fmtDeltaUSD(fullReportDeltaPosUSD)}`;
        msg += `  未領取 ${fmtDeltaUSD(fullReportDeltaUnclaimedUSD)}`;
        if (fullReportDeltaIlUSD !== 0) msg += `  獲利 ${fmtDeltaUSD(fullReportDeltaIlUSD)}`;
    }

    sorted.forEach(({ position, pool, bb, risk }, i) => {
        msg += buildTelegramPositionBlock(i + 1, position, pool, bb, risk);

        // 完整報告每倉位 Δ 差異行
        if (hasFullReportSnapshot) {
            const prev = fullReportSnapshot.get(position.tokenId);
            if (prev) {
                const dPos = position.positionValueUSD - prev.positionValueUSD;
                const dUncl = position.unclaimedFeesUSD - prev.unclaimedFeesUSD;
                const dIl = (position.ilUSD !== null && prev.ilUSD !== null)
                    ? position.ilUSD - prev.ilUSD : null;
                const parts: string[] = [
                    `倉位 ${fmtDeltaUSD(dPos)}`,
                    `未領取 ${fmtDeltaUSD(dUncl)}`,
                ];
                if (dIl !== null) parts.push(`獲利 ${fmtDeltaUSD(dIl)}`);
                msg += `\n   📅 vs上次: ${parts.join('  ')}`;
            }
        }
    });

    // 各池收益排行（顯示一次）
    if (allPools.length > 0) {
        const medals = ['🥇', '🥈', '🥉'];
        const activePoolIds = new Set(entries.map(e => e.position.poolAddress.toLowerCase()));
        msg += `\n📊 <b>各池收益排行:</b>`;
        allPools.forEach((p, i) => {
            const rank = medals[i] ?? '　';
            const label = `${p.dex} ${(p.feeTier * 100).toFixed(FMT.FEE_TIER).replace(/\.?0+$/, '')}%`;
            const feeAprPct = (p.apr * 100).toFixed(FMT.PCT_HUNDREDTH);
            const totalApr = p.apr + (p.farmApr ?? 0);
            const aprStr = p.farmApr !== undefined
                ? `APR <b>${(totalApr * 100).toFixed(FMT.PCT_HUNDREDTH)}%</b>(手續費${feeAprPct}%+農場${(p.farmApr * 100).toFixed(FMT.PCT_HUNDREDTH)}%)`
                : `APR <b>${feeAprPct}%</b>`;
            const tvl = p.tvlUSD >= 1000 ? `$${(p.tvlUSD / 1000).toFixed(FMT.USD_WHOLE)}K` : `$${p.tvlUSD.toFixed(FMT.USD_WHOLE)}`;
            const isMyPool = activePoolIds.has(p.id.toLowerCase());
            const tag = isMyPool ? ' ◀ 你的倉位' : '';
            const bb = appState.bbs[p.id.toLowerCase()];
            let inRangeTag = '';
            if (bb && !bb.isFallback && bb.sma > 0) {
                const eff = calculateCapitalEfficiency(bb.upperPrice, bb.lowerPrice, bb.sma);
                if (eff !== null) {
                    inRangeTag = ` → 區間 <b>${(totalApr * eff * 100).toFixed(FMT.PCT_TENTH)}%</b>`;
                }
            }
            // Migration suggestion: check if there's a higher-APR pool when this is my pool
            let migrationTag = '';
            if (isMyPool) {
                const myEntry = entries.find(e => e.position.poolAddress.toLowerCase() === p.id.toLowerCase());
                if (myEntry) {
                    const posValue = myEntry.position.positionValueUSD;
                    const bestAlt = allPools
                        .filter(alt => alt.id.toLowerCase() !== p.id.toLowerCase())
                        .sort((a, b) => (b.apr + (b.farmApr ?? 0)) - (a.apr + (a.farmApr ?? 0)))[0];
                    if (bestAlt) {
                        const altTotalApr = bestAlt.apr + (bestAlt.farmApr ?? 0);
                        const aprDiff = altTotalApr - totalApr;
                        if (aprDiff > 0 && posValue > 0) {
                            const gasCostUSD = 1; // ~$1 on Base
                            const dailyExtraIncome = posValue * aprDiff / 365;
                            const paybackDays = dailyExtraIncome > 0 ? Math.ceil(gasCostUSD / dailyExtraIncome) : Infinity;
                            if (paybackDays <= 30) {
                                migrationTag = ` 💡 移倉回本 ${paybackDays} 天`;
                            }
                        }
                    }
                }
            }
            msg += `\n${rank} ${label} — ${aprStr}${inRangeTag} | TVL ${tvl}${tag}${migrationTag}`;
        });
    }

    // BB k 值與更新時間
    msg += `\n\n⌛ <b>資料更新時間:</b>`;
    msg += `\n- Pool: ${formatTs(lastUpdates.poolScanner)} | Position: ${formatTs(lastUpdates.positionScanner)}`;
    msg += `\n- BB Engine: ${formatTs(lastUpdates.bbEngine)} | Risk: ${formatTs(lastUpdates.riskManager)}`;
    msg += `\n📐 BB k: low=<b>${appState.bbKLowVol}</b>  high=<b>${appState.bbKHighVol}</b>`;

    // 更新 fullReportSnapshot（完整報告獨立管理，不影響快訊計時）
    for (const { position } of entries) {
        fullReportSnapshot.set(position.tokenId, {
            positionValueUSD: position.positionValueUSD,
            unclaimedFeesUSD: position.unclaimedFeesUSD,
            ilUSD: position.ilUSD,
        });
    }

    await sendAlert(msg);
}
