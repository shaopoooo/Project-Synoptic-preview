import { Bot } from 'grammy';
import { config } from '../config';
import { PoolStats } from '../services/PoolScanner';
import { RiskAnalysis, RiskManager } from '../services/RiskManager';
import { BBResult } from '../services/BBEngine';
import { PositionRecord } from '../services/PositionScanner';
import { createServiceLogger } from '../utils/logger';

const log = createServiceLogger('TelegramBot');

type SortBy = 'size' | 'apr' | 'unclaimed' | 'health';

const SORT_LABELS: Record<SortBy, string> = {
    size:      '倉位大小',
    apr:       'APR',
    unclaimed: 'Unclaimed',
    health:    'Health Score',
};

export class TelegramBotService {
    private bot: Bot;
    private chatId: string;
    private sortBy: SortBy = 'size';

    constructor() {
        this.bot = new Bot(config.BOT_TOKEN);
        this.chatId = config.CHAT_ID;

        this.bot.command('start', (ctx) => {
            ctx.reply('DexInfoBot started! Monitoring Base network DEX pools...');
        });

        this.bot.command('sort', (ctx) => {
            const key = (ctx.match?.trim() ?? '') as SortBy;
            const valid = Object.keys(SORT_LABELS) as SortBy[];
            if (valid.includes(key)) {
                this.sortBy = key;
                ctx.reply(`✅ 排序已設為: <b>${SORT_LABELS[key]}</b> ↓`, { parse_mode: 'HTML' });
            } else {
                ctx.reply(
                    `排序選項:\n` +
                    valid.map(k => `  /sort ${k} — ${SORT_LABELS[k]}`).join('\n') +
                    `\n\n目前排序: <b>${SORT_LABELS[this.sortBy]}</b>`,
                    { parse_mode: 'HTML' }
                );
            }
        });

        this.bot.command('explain', (ctx) => {
            const msg =
                `📖 <b>指標計算說明</b>\n\n` +
                `<b>健康分數</b> (0–100)\n` +
                `= 50 + (Unclaimed + IL) / 本金 × 1000\n` +
                `50 = 損益兩平，100 = 盈利 ≥5%\n\n` +
                `<b>IL（絕對 PNL）</b>\n` +
                `= LP現值 + 累計手續費 - 初始本金\n` +
                `正值 🟢 = 盈利，負值 🔴 = 虧損\n\n` +
                `<b>Breakeven 天數</b>\n` +
                `= |IL| / 每日手續費收入\n` +
                `代表需幾天費用彌補目前 IL\n\n` +
                `<b>Compound Threshold</b>\n` +
                `= √(2 × 本金 × Gas費 × 24h費率)\n` +
                `Unclaimed > Threshold → 建議複利\n\n` +
                `<b>淨 APR</b>\n` +
                `= 池子費用APR + IL年化率\n` +
                `IL年化率 = IL / 本金 / 持倉天數 × 365\n` +
                `需設定建倉本金才會顯示\n\n` +
                `<b>DRIFT 警告</b>\n` +
                `重疊度 = 倉位落在 BB 內的比例\n` +
                `< 80% 時觸發，建議重建倉`;
            ctx.reply(msg, { parse_mode: 'HTML' });
        });
    }

    public async startBot() {
        log.info('Starting Telegram Bot...');
        await this.bot.start({
            onStart: () => {
                log.info('Telegram Bot is running.');
            },
        });
    }

    public async sendAlert(message: string) {
        if (!this.chatId) {
            log.warn('CHAT_ID not set. Cannot send telegram alert.');
            log.warn(`Message: ${message}`);
            return;
        }
        try {
            await this.bot.api.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            log.error(`Failed to send telegram message: ${error}`);
        }
    }

    /** 格式化單一倉位區塊（供 sendConsolidatedReport 使用） */
    private formatPositionBlock(
        index: number,
        position: PositionRecord,
        pool: PoolStats,
        bb: BBResult | null,
        risk: RiskAnalysis
    ): string {
        const aprStr = (pool.apr * 100).toFixed(1);
        const label = `${pool.dex} ${(pool.feeTier * 100).toFixed(4).replace(/\.?0+$/, '')}%`;
        const walletShort = position.ownerWallet
            ? `${position.ownerWallet.slice(0, 6)}...${position.ownerWallet.slice(-4)}`
            : '未知';
        const posValue = position.positionValueUSD > 0
            ? `$${position.positionValueUSD.toFixed(0)}`
            : 'N/A';
        const ilDisplay = position.ilUSD === null
            ? '未設定'
            : position.ilUSD >= 0
                ? `+$${position.ilUSD.toFixed(1)} 🟢`
                : `-$${Math.abs(position.ilUSD).toFixed(1)} 🔴`;
        const bbBound = (bb && position.bbMinPrice && position.bbMaxPrice)
            ? `${position.bbMinPrice} ~ ${position.bbMaxPrice}${position.bbFallback ? ' ⚠️' : ''}`
            : '無數據';
        const cmp = risk.compoundSignal ? '✅' : '❌';

        // 淨 APR：費用APR + IL年化率（需有建倉時間與初始本金）
        const capital = config.INITIAL_INVESTMENT_USD[position.tokenId] ?? 0;
        let netAprRow = '';
        if (position.openTimestampMs && position.ilUSD !== null && capital > 0) {
            const daysOpen = Math.max(1, (Date.now() - position.openTimestampMs) / 86400000);
            const ilAnnualRate = (position.ilUSD / capital) / daysOpen * 365;
            const netApr = pool.apr + ilAnnualRate;
            const sign = ilAnnualRate >= 0 ? '+' : '';
            netAprRow = `淨APR <b>${(netApr * 100).toFixed(1)}%</b> (IL年化 ${sign}${(ilAnnualRate * 100).toFixed(1)}%)\n`;
        }

        let block = `\n━━ #${index} ${label} ━━\n`;
        block += `APR <b>${aprStr}%</b> | 倉位 ${posValue} | 健康 ${risk.healthScore}/100\n`;
        if (netAprRow) block += netAprRow;
        block += `👛 ${walletShort} · #${position.tokenId}\n`;
        block += `💹 當前 ${position.currentPriceStr} | ${position.regime}\n`;
        block += `  你的: ${position.minPrice} ~ ${position.maxPrice}\n`;
        block += `  BB:   ${bbBound}\n`;
        block += `💸 Unclaimed $${position.unclaimedFeesUSD.toFixed(1)} | IL ${ilDisplay}\n`;
        block += `⏱ Breakeven ${risk.ilBreakevenDays}天 · Compound ${cmp} $${position.unclaimedFeesUSD.toFixed(1)} ${risk.compoundSignal ? '>' : '<'} $${risk.compoundThreshold.toFixed(1)}\n`;

        if (risk.redAlert) block += `🚨 <b>RED_ALERT</b>: Breakeven &gt;${RiskManager.RED_ALERT_BREAKEVEN_DAYS}天 (建議減倉)\n`;
        if (risk.highVolatilityAvoid) block += `⚠️ <b>HIGH_VOLATILITY_AVOID</b> (建議觀望)\n`;
        if (risk.driftWarning) {
            block += `⚠️ <b>DRIFT</b> 重疊 ${risk.driftOverlapPct.toFixed(1)}%`;
            if (position.rebalance) {
                const rb = position.rebalance;
                block += ` | 💡 ${rb.strategyName}`;
                if (rb.estGasCost > 0) block += ` (Gas $${rb.estGasCost.toFixed(2)})`;
            } else {
                block += ` (建議依 BB 重建倉)`;
            }
            block += '\n';
        }

        return block;
    }

    /** 將所有倉位合併為單一 Telegram 報告 */
    public async sendConsolidatedReport(
        entries: Array<{ position: PositionRecord; pool: PoolStats; bb: BBResult | null; risk: RiskAnalysis }>,
        allPools: PoolStats[],
        lastUpdates: { poolScanner: number; positionScanner: number; bbEngine: number; riskManager: number }
    ) {
        const timeFormatter = new Intl.DateTimeFormat('zh-TW', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
            timeZone: 'Asia/Taipei',
        });
        const timeStr = timeFormatter.format(new Date()).replace(/\//g, '-').replace(',', '');
        const formatTs = (ts: number) => ts === 0 ? '無紀錄' : timeFormatter.format(new Date(ts)).replace(/\//g, '-').replace(',', '').split(' ')[1];

        // 依當前排序鍵由大到小排列
        const sorted = [...entries].sort((a, b) => {
            switch (this.sortBy) {
                case 'apr':       return b.pool.apr - a.pool.apr;
                case 'unclaimed': return b.position.unclaimedFeesUSD - a.position.unclaimedFeesUSD;
                case 'health':    return b.risk.healthScore - a.risk.healthScore;
                case 'size':
                default:          return b.position.positionValueUSD - a.position.positionValueUSD;
            }
        });

        let msg = `<b>[${timeStr}] 倉位監控報告 (${sorted.length} 個倉位 | 排序: ${SORT_LABELS[this.sortBy]} ↓)</b>`;

        sorted.forEach(({ position, pool, bb, risk }, i) => {
            msg += this.formatPositionBlock(i + 1, position, pool, bb, risk);
        });

        // 各池收益排行（顯示一次）
        if (allPools.length > 0) {
            const medals = ['🥇', '🥈', '🥉'];
            const activePoolIds = new Set(entries.map(e => e.position.poolAddress.toLowerCase()));
            msg += `\n📊 <b>各池收益排行:</b>`;
            allPools.forEach((p, i) => {
                const rank = medals[i] ?? '　';
                const label = `${p.dex} ${(p.feeTier * 100).toFixed(4).replace(/\.?0+$/, '')}%`;
                const aprPct = (p.apr * 100).toFixed(1);
                const tvl = p.tvlUSD >= 1000 ? `$${(p.tvlUSD / 1000).toFixed(0)}K` : `$${p.tvlUSD.toFixed(0)}`;
                const tag = activePoolIds.has(p.id.toLowerCase()) ? ' ◀ 你的倉位' : '';
                msg += `\n${rank} ${label} — APR <b>${aprPct}%</b> | TVL ${tvl}${tag}`;
            });
        }

        // 更新時間（顯示一次）
        msg += `\n\n⏱ <b>資料更新時間:</b>`;
        msg += `\n- Pool: ${formatTs(lastUpdates.poolScanner)} | Position: ${formatTs(lastUpdates.positionScanner)}`;
        msg += `\n- BB Engine: ${formatTs(lastUpdates.bbEngine)} | Risk: ${formatTs(lastUpdates.riskManager)}`;

        await this.sendAlert(msg);
    }
}
