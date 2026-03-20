import { config } from '../config';
import { PoolStats, BBResult, PositionRecord, RiskAnalysis } from '../types';
import { getTokenPrices } from '../utils/tokenPrices';
import { buildTelegramPositionBlock } from '../utils/formatter';
import { appState } from '../utils/AppState';
import { isValidWalletAddress } from '../utils/validation';
import { calculateCapitalEfficiency } from '../utils/math';

const FMT = config.FMT;

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
    const fmtUSD = (v: number) => v >= 0 ? `+$${v.toFixed(FMT.USD_TENTH)}` : `-$${Math.abs(v).toFixed(FMT.USD_TENTH)}`;

    let msg = `<b>[${timeStr}] 倉位監控報告 (${sorted.length} 個倉位 | 排序: ${config.SORT_LABELS[sortBy]} ↓)</b>`;
    msg += `\n\n📊 <b>總覽</b>  ${entries.length} 倉位 · ${walletCount} 錢包`;
    msg += `\n💼 總倉位 <b>$${totalPositionUSD.toFixed(FMT.USD_WHOLE)}</b>  |  本金 <b>$${totalInitialCapital.toFixed(FMT.USD_WHOLE)}</b>  |  Unclaimed <b>$${totalUnclaimedUSD.toFixed(FMT.USD_TENTH)}</b>`;

    // 即時幣價（由獨立 tokenPrices 模組提供，不依賴 BBEngine 是否成功）
    const tp = getTokenPrices();
    const p = (v: number, d: number) => v > 0 ? `$${v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}` : '–';
    msg += `\n💱 ETH ${p(tp.ethPrice, 0)}  BTC ${p(tp.cbbtcPrice, 0)}  CAKE ${p(tp.cakePrice, 3)}  AERO ${p(tp.aeroPrice, 3)}`;

    if (totalPnL !== null) {
        const icon = totalPnL >= 0 ? '🟢' : '🔴';
        const pctStr = totalPnLPct !== null
            ? ` (${totalPnLPct >= 0 ? '+' : ''}${totalPnLPct.toFixed(FMT.PCT_HUNDREDTH)}%)`
            : '';
        msg += `\n💰 總獲利 <b>${fmtUSD(totalPnL)}${pctStr}</b> ${icon}`;
    }

    sorted.forEach(({ position, pool, bb, risk }, i) => {
        msg += buildTelegramPositionBlock(i + 1, position, pool, bb, risk);
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
                    const myTotalApr = totalApr;
                    const bestAlt = allPools
                        .filter(alt => alt.id.toLowerCase() !== p.id.toLowerCase())
                        .sort((a, b) => (b.apr + (b.farmApr ?? 0)) - (a.apr + (a.farmApr ?? 0)))[0];
                    if (bestAlt) {
                        const altTotalApr = bestAlt.apr + (bestAlt.farmApr ?? 0);
                        const aprDiff = altTotalApr - myTotalApr;
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

    await sendAlert(msg);
}
