import { PositionRecord, PoolStats, BBResult, RiskAnalysis, TokenPrices } from '../types';
import type { CalcResult } from '../services/PositionCalculator';
import { config } from '../config';
import { isValidWalletAddress } from './validation';
import { normalizeRawAmount } from './math';
import { TOKEN_DECIMALS } from './tokenInfo';

const FMT = config.FMT;

/** 格式化幣價，未設定（≤0）時顯示 '–' */
export function fmtTokenPrice(v: number, decimals: number): string {
    return v > 0 ? `$${v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}` : '–';
}

/** 格式化 USD 差值，帶正負符號 */
export function fmtDeltaUSD(delta: number, precision = 1): string {
    const sign = delta >= 0 ? '+' : '-';
    return `${sign}$${Math.abs(delta).toFixed(precision)}`;
}

/** Telegram 幣價行：💱 ETH $X  BTC $X  CAKE $X  AERO $X */
export function buildTokenPriceLine(tp: TokenPrices): string {
    return `💱 ETH ${fmtTokenPrice(tp.ethPrice, 0)} · BTC ${fmtTokenPrice(tp.cbbtcPrice, 0)} · CAKE ${fmtTokenPrice(tp.cakePrice, 3)} · AERO ${fmtTokenPrice(tp.aeroPrice, 3)}`;
}

export function fmtInterval(min: number): string {
    if (min < 60) return `${min} 分鐘`;
    if (min === 60) return `1 小時`;
    if (min < 1440) return `${min / 60} 小時`;
    return `1 天`;
}

/** 將極小數字格式化為緊湊表示法：小數點後 ≥2 個零時使用下標 */
export function compactAmount(n: number): string {
    if (n <= 0) return '0';
    const s = n.toFixed(20);
    const dec = s.split('.')[1] || '';
    let zeros = 0;
    for (const c of dec) { if (c === '0') zeros++; else break; }
    if (zeros >= 2) {
        const sig = dec.slice(zeros, zeros + 4).replace(/0+$/, '');
        const sub = '₀₁₂₃₄₅₆₇₈₉';
        const subscript = String(zeros).split('').map(d => sub[+d]).join('');
        return `0.0${subscript}${sig}`;
    }
    return n.toFixed(zeros + 4).replace(/\.?0+$/, '');
}

/** 格式化代幣數量為日誌格式 */
export function formatTokenCompactLog(unclaimed: string | undefined, decimals: number, symbol: string, usdValue: number): string | null {
    if (!unclaimed || unclaimed === '0') return null;
    try {
        const num = normalizeRawAmount(unclaimed, decimals);
        if (num <= 0) return null;
        const display = compactAmount(num);
        return `${display} ${symbol} ($${usdValue.toFixed(FMT.USD_CENTS)})`;
    } catch {
        return null;
    }
}

/** 英文市場狀態顯示 */
export function regimeEn(regime: string): string {
    if (regime === 'Low Volatility') return 'Low Vol';
    if (regime === 'High Volatility') return 'High Vol';
    if (regime === '資料累積中') return 'Warmup';
    return regime;
}

/** 格式化單一倉位區塊（供 sendConsolidatedReport 使用） */
export function buildTelegramPositionBlock(
    index: number,
    position: PositionRecord,
    pool: PoolStats,
    bb: BBResult | null,
    risk: RiskAnalysis,
    compact = false,
    diff?: { dPos: number; dUncl: number; dIl: number | null }
): string {
    const label = `${pool.dex} ${(pool.feeTier * 100).toFixed(FMT.FEE_TIER).replace(/\.?0+$/, '')}%`;
    const walletShort = position.ownerWallet && isValidWalletAddress(position.ownerWallet)
        ? `${position.ownerWallet.slice(0, 6)}...${position.ownerWallet.slice(-4)}`
        : '未知';
    const posValue = position.positionValueUSD > 0
        ? `$${position.positionValueUSD.toFixed(FMT.USD_WHOLE)}`
        : 'N/A';
    const initialCapital = position.initialCapital ?? null;
    const capitalStr = initialCapital !== null ? `$${initialCapital.toFixed(FMT.USD_WHOLE)}` : 'N/A';

    // 淨損益 = LP現值 + Unclaimed - 本金（含手續費貢獻）
    const pnlDisplay = position.ilUSD === null
        ? '未設定本金'
        : position.ilUSD >= 0
            ? `+$${position.ilUSD.toFixed(FMT.USD_TENTH)} 🟢`
            : `-$${Math.abs(position.ilUSD).toFixed(FMT.USD_TENTH)} 🔴`;

    // 無常損失 = LP現值 - 本金（純市價波動，不含手續費）
    const ilOnly = initialCapital !== null ? position.positionValueUSD - initialCapital : null;
    const ilOnlyDisplay = ilOnly === null
        ? ''
        : ilOnly >= 0
            ? `+$${ilOnly.toFixed(FMT.USD_TENTH)} 🟢`
            : `-$${Math.abs(ilOnly).toFixed(FMT.USD_TENTH)} 🔴`;

    const bbBound = (bb && position.bbMinPrice && position.bbMaxPrice)
        ? `${position.bbMinPrice} ~ ${position.bbMaxPrice}${position.bbFallback ? ' ⚠️' : ''}`
        : '無數據';
    const cmp = risk.compoundSignal ? '✅' : '❌';

    const timeStr = (position.openedDays !== undefined && position.openedHours !== undefined)
        ? `${position.openedDays}天${position.openedHours}小時`
        : null;
    const profitStr = (position.profitRate !== null && position.profitRate !== undefined)
        ? ` · 獲利 <b>${position.profitRate >= 0 ? '+' : ''}${position.profitRate.toFixed(FMT.PCT_HUNDREDTH)}%</b>`
        : '';
    const breakevenStr = (position.ilUSD !== null && position.ilUSD >= 0) ? '盈利中' : `${risk.ilBreakevenDays}天`;

    const lockIcon = position.isStaked ? ' 🔒' : '';

    // ── Compact 模式：只顯示 2 行核心數據
    if (compact) {
        let block = `\n━━ #${index} ${label} ━━\n`;
        block += `👛 ${walletShort} · #${position.tokenId}${lockIcon}\n`;
        block += `💼 ${posValue} · 💸 ${pnlDisplay} · 🔄 $${position.unclaimedFeesUSD.toFixed(FMT.USD_CENTS)} · ❤️ ${risk.healthScore}/100\n`;
        if (risk.redAlert) block += `🚨 <b>RED_ALERT</b>\n`;
        if (risk.driftWarning) block += `⚠️ <b>DRIFT</b> ${risk.driftOverlapPct.toFixed(FMT.PCT_TENTH)}%\n`;
        return block;
    }

    // ── 標頭
    let block = `\n━━ #${index} ${label} ━━\n`;
    // ── 錢包（第二行）
    block += `👛 ${walletShort} · #${position.tokenId}${lockIcon}\n`;
    // ── 開倉時間
    if (timeStr) block += `⏳ 開倉 ${timeStr}\n`;
    // ── 價格 + 區間（縮排）
    block += `💹 當前 ${position.currentPriceStr} · ${position.regime}\n`;
    block += ` ├ 你的 ${position.minPrice} ~ ${position.maxPrice}\n`;
    block += ` └ 建議 ${bbBound}\n`;
    // ── 倉位摘要（縮排）
    block += `💼 倉位 ${posValue} · 本金 ${capitalStr} · 健康 ${risk.healthScore}/100\n`;
    // ── 區間 APR（有 BB 且非 fallback 才顯示）
    if (position.inRangeApr !== undefined && pool.apr > 0) {
        const multiplier = position.inRangeApr / pool.apr;
        block += `📈 區間 APR <b>${(position.inRangeApr * 100).toFixed(FMT.PCT_TENTH)}%</b>` +
            ` (效率 ${multiplier.toFixed(FMT.PCT_TENTH)}×)\n`;
    }
    // ── Breakeven + 獲利率同行
    block += `⌛ 收支 ${breakevenStr}${profitStr}\n`;
    // ── 完整報告差異
    if (diff) block += `${buildPositionDiffLine(diff.dPos, diff.dUncl, diff.dIl)}\n`;
    // ── 淨損益 + 無常損失
    block += `💸 損益 ${pnlDisplay}`;
    if (ilOnlyDisplay) block += ` · 無常損失 ${ilOnlyDisplay}`;
    block += '\n';
    // ── 持倉數量
    block += `🪙 持倉 ${compactAmount(position.amount0)} ${position.token0Symbol} · ${compactAmount(position.amount1)} ${position.token1Symbol}\n`;
    // ── 建議領取：未領取手續費 + 逐幣明細
    const dec0 = TOKEN_DECIMALS[position.token0Symbol] ?? 18;
    const dec1 = TOKEN_DECIMALS[position.token1Symbol] ?? 18;
    const dec2 = TOKEN_DECIMALS[position.token2Symbol] ?? 18;
    const amt0 = normalizeRawAmount(position.unclaimed0, dec0);
    const amt1 = normalizeRawAmount(position.unclaimed1, dec1);
    const amt2 = normalizeRawAmount(position.unclaimed2, dec2);
    const feeDetail = [
        amt0 > 0 ? `${compactAmount(amt0)} ${position.token0Symbol} ($${position.fees0USD.toFixed(FMT.USD_CENTS)})` : '',
        amt1 > 0 ? `${compactAmount(amt1)} ${position.token1Symbol} ($${position.fees1USD.toFixed(FMT.USD_CENTS)})` : '',
        amt2 > 0 && position.token2Symbol ? `${compactAmount(amt2)} ${position.token2Symbol} ($${position.fees2USD.toFixed(FMT.USD_CENTS)})` : '',
    ].filter(Boolean);
    block += `🔄 未領取 $${position.unclaimedFeesUSD.toFixed(FMT.USD_CENTS)} ${cmp} ${risk.compoundSignal ? '&gt;' : '&lt;'} $${risk.compoundThreshold.toFixed(FMT.USD_TENTH)}\n`;
    for (const line of feeDetail) block += `     ${line}\n`;
    // ── 警示
    if (risk.redAlert) block += `🚨 <b>RED_ALERT</b>: Breakeven &gt;30天 (建議減倉)\n`;
    if (risk.highVolatilityAvoid) block += `⚠️ <b>HIGH_VOLATILITY_AVOID</b> (建議觀望)\n`;
    if (risk.driftWarning) {
        block += `⚠️ <b>DRIFT</b> 重疊 ${risk.driftOverlapPct.toFixed(FMT.PCT_TENTH)}%`;
        if (position.rebalance) {
            const rb = position.rebalance;
            block += ` · 💡 ${rb.strategyName}`;
            if (rb.estGasCost > 0) block += ` (Gas $${rb.estGasCost.toFixed(FMT.USD_CENTS)})`;
        } else {
            block += ` (建議依 BB 重建倉)`;
        }
        block += '\n';
    }

    return block;
}

// ── Telegram 報告區塊 ─────────────────────────────────────────────────────────

/** 倉位差異行（由 caller 傳入預算差值） */
export function buildPositionDiffLine(dPos: number, dUncl: number, dIl: number | null): string {
    const parts = [`倉位 ${fmtDeltaUSD(dPos)}`, `未領取 ${fmtDeltaUSD(dUncl)}`];
    if (dIl !== null) parts.push(`獲利 ${fmtDeltaUSD(dIl)}`);
    return `📅 差異 ${parts.join(' · ')}`;
}

/** 完整報告標頭 + 總覽區塊 */
export interface SummaryBlockData {
    reportTimeStr: string;
    positionCount: number;
    sortLabel: string;
    walletCount: number;
    totalPositionUSD: number;
    totalInitialCapital: number;
    totalUnclaimedUSD: number;
    tp: TokenPrices;
    totalPnL: number | null;
    totalPnLPct: number | null;
    overallDelta?: { dPos: number; dUncl: number; dIl: number | null };
}
export function buildSummaryBlock(data: SummaryBlockData): string {
    const { reportTimeStr, positionCount, sortLabel, walletCount,
        totalPositionUSD, totalInitialCapital, totalUnclaimedUSD,
        tp, totalPnL, totalPnLPct, overallDelta } = data;
    let msg = `<b>[${reportTimeStr}] 倉位監控報告 (${positionCount} 個倉位 | 排序: ${sortLabel} ↓)</b>`;
    msg += `\n\n📊 <b>總覽</b>  ${positionCount} 倉位 · ${walletCount} 錢包`;
    msg += `\n💼 總倉位 <b>$${totalPositionUSD.toFixed(FMT.USD_WHOLE)}</b>  ·  本金 <b>$${totalInitialCapital.toFixed(FMT.USD_WHOLE)}</b>  ·  未領取 <b>$${totalUnclaimedUSD.toFixed(FMT.USD_CENTS)}</b>`;
    msg += `\n${buildTokenPriceLine(tp)}`;
    if (totalPnL !== null) {
        const icon = totalPnL >= 0 ? '🟢' : '🔴';
        const pctStr = totalPnLPct !== null
            ? ` (${totalPnLPct >= 0 ? '+' : ''}${totalPnLPct.toFixed(FMT.PCT_HUNDREDTH)}%)`
            : '';
        msg += `\n💰 總獲利 <b>${fmtDeltaUSD(totalPnL, FMT.USD_TENTH)}${pctStr}</b> ${icon}`;
    }
    if (overallDelta) msg += `\n${buildPositionDiffLine(overallDelta.dPos, overallDelta.dUncl, overallDelta.dIl)}`;
    return msg;
}

/** 池排行每列資料（raw 數值，格式化由 buildPoolRankingBlock 完成） */
export interface PoolRankingRow {
    rank: string;       // medal emoji
    dex: string;
    feeTier: number;
    apr: number;
    farmApr?: number;
    tvlUSD: number;
    isMyPool: boolean;
    inRangeApr: number | null;
    migrationPaybackDays: number | null;
}
export function buildPoolRankingBlock(rows: PoolRankingRow[]): string {
    if (rows.length === 0) return '';
    let msg = `\n📊 <b>各池收益排行:</b>`;
    for (const r of rows) {
        const label = `${r.dex} ${(r.feeTier * 100).toFixed(FMT.FEE_TIER).replace(/\.?0+$/, '')}%`;
        const feeAprPct = (r.apr * 100).toFixed(FMT.PCT_HUNDREDTH);
        const totalApr = r.apr + (r.farmApr ?? 0);
        const aprStr = r.farmApr !== undefined
            ? `APR <b>${(totalApr * 100).toFixed(FMT.PCT_HUNDREDTH)}%</b>(手續費${feeAprPct}%+農場${(r.farmApr * 100).toFixed(FMT.PCT_HUNDREDTH)}%)`
            : `APR <b>${feeAprPct}%</b>`;
        const inRangeTag = r.inRangeApr !== null
            ? ` → 區間 <b>${(r.inRangeApr * 100).toFixed(FMT.PCT_TENTH)}%</b>`
            : '';
        const tvl = r.tvlUSD >= 1000
            ? `$${(r.tvlUSD / 1000).toFixed(FMT.USD_WHOLE)}K`
            : `$${r.tvlUSD.toFixed(FMT.USD_WHOLE)}`;
        const myTag = r.isMyPool ? ' ◀ 你的倉位' : '';
        const migrationTag = r.migrationPaybackDays !== null
            ? ` 💡 移倉回本 ${r.migrationPaybackDays} 天`
            : '';
        msg += `\n${r.rank} ${label} — ${aprStr}${inRangeTag} · TVL ${tvl}${myTag}${migrationTag}`;
    }
    return msg;
}

/** BB k 值 + 更新時間區塊 */
export function buildTimestampBlock(
    lastUpdates: { poolScanner: number; positionScanner: number; bbEngine: number; riskManager: number },
    bbKLow: number,
    bbKHigh: number
): string {
    const fmt = new Intl.DateTimeFormat('zh-TW', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei',
    });
    const ts = (t: number) => t === 0 ? '無紀錄' : fmt.format(new Date(t));
    let msg = `\n\n⌛ <b>資料更新時間:</b>`;
    msg += `\n- Pool: ${ts(lastUpdates.poolScanner)} · Position: ${ts(lastUpdates.positionScanner)}`;
    msg += `\n- BB Engine: ${ts(lastUpdates.bbEngine)} · Risk: ${ts(lastUpdates.riskManager)}`;
    msg += `\n📐 BB k: low=<b>${bbKLow}</b>  high=<b>${bbKHigh}</b>`;
    return msg;
}

export interface FlashHolding {
    symbol: string;
    amount: number;
    usdValue: number;   // 0 表示無報價
}

export type FlashAlert =
    | { type: 'outOfRange'; tokenId: string }
    | { type: 'redAlert'; tokenId: string }
    | { type: 'drift'; tokenId: string; overlapPct: number }
    | { type: 'highVol'; tokenId: string }
    | { type: 'compound'; tokenId: string; unclaimedUSD: number };

/** 快訊報告資料（raw 數值，格式化由 buildFlashReport 完成） */
export interface FlashReportData {
    nowTs: number;
    tp: TokenPrices;
    totalPositionUSD: number;
    totalUnclaimedUSD: number;
    totalPnL: number | null;
    totalPnLPct: number | null;
    holdings: FlashHolding[];           // 已按 usdValue 由大到小排序
    deltaFees: { amount: number; prevSnapshotTs: number } | null;
    alerts: FlashAlert[];
}
export function buildFlashReport(data: FlashReportData): string {
    const { nowTs, tp, totalPositionUSD, totalUnclaimedUSD,
        totalPnL, totalPnLPct, holdings, deltaFees, alerts } = data;

    const timeFmt = new Intl.DateTimeFormat('zh-TW', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei',
    });
    const timeStr = timeFmt.format(new Date(nowTs));

    let msg = `📡 <b>[${timeStr}] 快訊</b>`;
    msg += `\n${buildTokenPriceLine(tp)}`;
    msg += `\n💼 總倉位 <b>$${totalPositionUSD.toFixed(FMT.USD_WHOLE)}</b> · 未領取 <b>$${totalUnclaimedUSD.toFixed(FMT.USD_CENTS)}</b>`;

    if (totalPnL !== null) {
        const icon = totalPnL >= 0 ? '🟢' : '🔴';
        const pctStr = totalPnLPct !== null
            ? ` (${totalPnLPct >= 0 ? '+' : ''}${totalPnLPct.toFixed(FMT.PCT_HUNDREDTH)}%)`
            : '';
        msg += `\n💰 獲利 <b>${fmtDeltaUSD(totalPnL, FMT.USD_CENTS)}${pctStr}</b> ${icon}`;
    }

    if (holdings.length > 0) {
        const parts = holdings.map(h => {
            const usdStr = h.usdValue > 0 ? `(${Math.round(h.usdValue)}U)` : '';
            return `${compactAmount(h.amount)} ${h.symbol}${usdStr}`;
        });
        msg += `\n🪙 持倉 ${Math.round(totalPositionUSD)}U`;
        for (let i = 0; i < parts.length; i += 2) {
            msg += `\n   ${parts[i + 1] ? `${parts[i]} · ${parts[i + 1]}` : parts[i]}`;
        }
    }

    if (deltaFees) {
        const prevStr = timeFmt.format(new Date(deltaFees.prevSnapshotTs));
        msg += `\n📈 本週期手續費 <b>${fmtDeltaUSD(deltaFees.amount, FMT.USD_CENTS)}</b> (vs ${prevStr})`;
    }

    if (alerts.length > 0) {
        const alertLines = alerts.map(a => {
            switch (a.type) {
                case 'outOfRange': return `⚠️ #${a.tokenId} 穿倉`;
                case 'redAlert': return `🚨 #${a.tokenId} RED_ALERT: Breakeven &gt;30天`;
                case 'drift': return `⚠️ #${a.tokenId} DRIFT 重疊 ${a.overlapPct.toFixed(FMT.PCT_TENTH)}%`;
                case 'highVol': return `⚠️ #${a.tokenId} HIGH_VOLATILITY_AVOID`;
                case 'compound': return `✅ #${a.tokenId} 可複利 $${a.unclaimedUSD.toFixed(FMT.USD_CENTS)}`;
            }
        });
        msg += `\n${alertLines.join('\n')}`;
    }

    return msg;
}

function toCST(d: Date): { date: string; hh: string; mm: string } {
    const cst = new Date(d.getTime() + 8 * 3600_000);
    return {
        date: cst.toISOString().slice(0, 10),
        hh: String(cst.getUTCHours()).padStart(2, '0'),
        mm: String(cst.getUTCMinutes()).padStart(2, '0'),
    };
}

/** Build the snapshot header line (with optional price row) for positions.log. */
export function buildLogSnapshotHeader(bb?: BBResult | null, kLow?: number, kHigh?: number): string {
    const now = new Date();
    const { date, hh, mm } = toCST(now);
    const timestamp = `${date} ${hh}:${mm} UTC+8`;
    const header = `═══ [${timestamp}] Snapshot ═══`;
    if (!bb) return header;
    const prices = `  ETH $${bb.ethPrice.toFixed(FMT.USD_WHOLE)}  BTC $${bb.cbbtcPrice.toFixed(FMT.USD_WHOLE)}  CAKE $${bb.cakePrice.toFixed(FMT.USD_MILLI)}  AERO $${bb.aeroPrice.toFixed(FMT.USD_MILLI)}`;
    const kStr = (kLow !== undefined && kHigh !== undefined) ? `  k=${kLow}/${kHigh}` : '';
    return header + '\n' + prices + kStr;
}

/** Format a single position as a plain-text block for positions.log. */
export function buildLogPositionBlock(pos: PositionRecord, tokenDecimals: Record<string, number>, bb?: BBResult | null): string {
    const now = new Date();
    const { hh, mm } = toCST(now);
    const timeStr = `${hh}:${mm}`;
    const label = `${pos.dex} ${(pos.feeTier * 100).toFixed(FMT.FEE_TIER).replace(/\.?0+$/, '')}%`;
    const walletShort = pos.ownerWallet
        ? `${pos.ownerWallet.slice(0, 6)}...${pos.ownerWallet.slice(-4)}`
        : 'unknown';

    const openedStr = pos.openedDays !== undefined
        ? (pos.openedDays > 0 ? `${pos.openedDays}d ${pos.openedHours}h` : `${pos.openedHours}h`)
        : 'unknown';

    const posValue = pos.positionValueUSD > 0 ? `$${pos.positionValueUSD.toFixed(FMT.USD_WHOLE)}` : 'N/A';
    const capStr = pos.initialCapital !== null && pos.initialCapital !== undefined
        ? `$${pos.initialCapital.toFixed(FMT.USD_WHOLE)}` : 'N/A';
    const aprStr = pos.apr !== undefined ? `${(pos.apr * 100).toFixed(FMT.PCT_TENTH)}%` : 'N/A';
    const inRangeAprStr = pos.inRangeApr !== undefined
        ? ` (區間 ${(pos.inRangeApr * 100).toFixed(FMT.PCT_TENTH)}%)`
        : '';

    const pnlSign = pos.ilUSD === null ? '' : pos.ilUSD >= 0 ? '+' : '-';
    const pnlAbs = pos.ilUSD === null ? 'N/A' : `$${Math.abs(pos.ilUSD).toFixed(FMT.USD_TENTH)}`;
    const pnlTag = pos.ilUSD === null ? '' : pos.ilUSD >= 0 ? '[+]' : '[-]';
    const pnlStr = pos.ilUSD === null ? 'N/A (no capital set)' : `${pnlSign}${pnlAbs} ${pnlTag}`;

    const bbBound = (pos.bbMinPrice && pos.bbMaxPrice)
        ? `${pos.bbMinPrice} ~ ${pos.bbMaxPrice}${pos.bbFallback ? ' [fallback]' : ''}`
        : 'N/A';

    const profitStr = (pos.profitRate !== null && pos.profitRate !== undefined)
        ? ` | Profit: ${pos.profitRate >= 0 ? '+' : ''}${pos.profitRate.toFixed(FMT.PCT_HUNDREDTH)}%`
        : '';
    const breakevenStr = (pos.ilUSD !== null && pos.ilUSD >= 0) ? 'Profitable' : `${pos.breakevenDays}d`;
    const compoundStr = pos.unclaimedFeesUSD >= config.EOQ_THRESHOLD ? 'YES' : 'no';

    const REBALANCE_STRATEGY: Record<string, string> = {
        wait: 'Wait (expect reversion)',
        dca: 'DCA buy-in',
        withdrawSingleSide: 'Withdraw & single-side LP',
        avoidSwap: 'Avoid direct swap',
    };

    const lines: string[] = [];
    lines.push(`[${timeStr}] ━━ #${pos.tokenId} ${label} ━━`);
    lines.push(`  Value: ${posValue} | Capital: ${capStr} | APR: ${aprStr}${inRangeAprStr} | Health: ${pos.healthScore}/100`);
    lines.push(`  Holdings:  ${compactAmount(pos.amount0)} ${pos.token0Symbol} | ${compactAmount(pos.amount1)} ${pos.token1Symbol}`);
    lines.push(`  Wallet:    ${walletShort}  (${openedStr})`);
    lines.push(`  Price:     ${pos.currentPriceStr} | ${regimeEn(pos.regime)}`);
    lines.push(`    Your:    ${pos.minPrice} ~ ${pos.maxPrice}`);
    lines.push(`    BB:      ${bbBound}`);
    lines.push(`  PnL:       ${pnlStr}${profitStr}`);
    lines.push(`  Unclaimed: $${pos.unclaimedFeesUSD.toFixed(FMT.USD_TENTH)} | Breakeven: ${breakevenStr} | Compound: ${compoundStr}`);
    const t0line = formatTokenCompactLog(pos.unclaimed0, tokenDecimals[pos.token0Symbol] ?? 18, pos.token0Symbol, pos.fees0USD);
    const t1line = formatTokenCompactLog(pos.unclaimed1, tokenDecimals[pos.token1Symbol] ?? 18, pos.token1Symbol, pos.fees1USD);
    const t2line = pos.token2Symbol ? formatTokenCompactLog(pos.unclaimed2, tokenDecimals[pos.token2Symbol] ?? 18, pos.token2Symbol, pos.fees2USD) : null;
    if (t0line) lines.push(`     ${t0line}`);
    if (t1line) lines.push(`     ${t1line}`);
    if (t2line) lines.push(`     ${t2line}`);
    const bbReady = !!(pos.bbMinPrice && pos.bbMaxPrice);
    if (bbReady && pos.overlapPercent < config.DRIFT_WARNING_PCT) {
        lines.push(`  [!] DRIFT WARNING: overlap ${pos.overlapPercent.toFixed(FMT.PCT_TENTH)}% < ${config.DRIFT_WARNING_PCT}%`);
    }
    if (bbReady && pos.rebalance) {
        const rb = pos.rebalance;
        const strategy = REBALANCE_STRATEGY[rb.recommendedStrategy] ?? rb.recommendedStrategy;
        lines.push(`  [!] REBALANCE: ${strategy} (drift ${rb.driftPercent > 0 ? '+' : ''}${rb.driftPercent.toFixed(FMT.PCT_TENTH)}%)`);
    }
    lines.push('─'.repeat(44));

    return lines.join('\n');
}

// ─── /calc 開倉試算報告 ───────────────────────────────────────────────────────

export function buildCalcReport(r: CalcResult): string {
    const dex = r.pool.dex;
    const feePct = `${(r.pool.feeTier * 100).toFixed(FMT.FEE_TIER).replace(/\.?0+$/, '')}%`;
    const totalApr = (r.pool.apr + (r.pool.farmApr ?? 0)) * 100;
    const lowerPct = ((r.lowerPrice - r.currentPrice) / r.currentPrice * 100).toFixed(1);
    const upperPct = ((r.upperPrice - r.currentPrice) / r.currentPrice * 100).toFixed(1);
    const rangeSourceLabel = r.rangeSource === 'BB' ? 'BB' : r.rangeSource === 'user' ? '自訂' : '預設 ±5%';

    const lines: string[] = [
        `📊 <b>開倉試算 — 池 #${r.poolRank}</b>`,
        `🏊 ${dex} ${feePct}  APR <b>${totalApr.toFixed(FMT.PCT_HUNDREDTH)}%</b>`,
        ``,
        `💰 資金: <b>${r.capital.toFixed(4)}</b> token0`,
        `📍 當前價: <b>${r.currentPrice.toFixed(FMT.PRICE)}</b>`,
        `📐 區間: ${lowerPct}% ~ +${upperPct}%  (${rangeSourceLabel})`,
        `   Pa=${r.lowerPrice.toFixed(FMT.PRICE)}  Pb=${r.upperPrice.toFixed(FMT.PRICE)}`,
        `⚡ 資金效率: <b>${r.capitalEfficiency.toFixed(1)}×</b>`,
        `💵 估算日費: <b>${r.dailyFeesToken0.toFixed(6)}</b> token0/day`,
        ``,
        `<b>⬇️ 下跌場景（token0 本位 IL）</b>`,
    ];

    for (const s of r.downScenarios) {
        const ilStr = s.ilToken0 < 0
            ? `-${Math.abs(s.ilToken0).toFixed(6)}`
            : `+${s.ilToken0.toFixed(6)}`;
        const dayStr = s.breakevenDays !== null
            ? `回本 ${s.breakevenDays.toFixed(1)} 天`
            : '已盈利';
        lines.push(`  ${s.label} (${s.priceChangePct.toFixed(1)}%): IL=${ilStr}  ${dayStr}`);
    }

    lines.push(``, `<b>⬆️ 上漲場景（token0 本位 IL）</b>`);

    for (const s of r.upScenarios) {
        const ilStr = s.ilToken0 < 0
            ? `-${Math.abs(s.ilToken0).toFixed(6)}`
            : `+${s.ilToken0.toFixed(6)}`;
        const dayStr = s.breakevenDays !== null
            ? `回本 ${s.breakevenDays.toFixed(1)} 天`
            : '已盈利';
        const pctStr = s.priceChangePct >= 0 ? `+${s.priceChangePct.toFixed(1)}` : s.priceChangePct.toFixed(1);
        lines.push(`  ${s.label} (${pctStr}%): IL=${ilStr}  ${dayStr}`);
    }

    if (r.rangeSource === 'fallback') {
        lines.push(``, `⚠️ 無 BB 資料，使用預設 ±5% 區間`);
    }

    return lines.join('\n');
}
