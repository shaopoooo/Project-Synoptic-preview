import type { Bot } from 'grammy';
import { appState } from '../../infra/AppState';
import { buildStrategyReport } from '../formatter';

export function registerCalcCommands(bot: Bot): void {
    bot.command('calc', async (ctx) => {
        const pools = appState.pools;
        if (pools.length === 0) {
            ctx.reply('⚠️ 尚無池子資料，請稍後再試。');
            return;
        }

        const parts = (ctx.match?.trim() ?? '').split(/\s+/).filter(Boolean);

        // 用法: /calc <capital> [rank]
        // e.g.: /calc 1.5     → 1.5 token0，APR #1 池
        //       /calc 1.5 2   → APR #2 池

        const capital = parseFloat(parts[0] ?? '');
        if (!parts[0] || isNaN(capital) || capital <= 0) {
            ctx.reply(
                '📊 <b>MC 開倉策略</b>\n\n' +
                '用法: <code>/calc &lt;資金 token0&gt; [池排名 1-5]</code>\n\n' +
                '範例:\n' +
                '<code>/calc 1.5</code>    — 1.5 token0，APR 最高池\n' +
                '<code>/calc 1.5 2</code>  — APR 第 2 高池\n\n' +
                '📌 策略由 MC 引擎預先計算，每個 cron 週期更新一次',
                { parse_mode: 'HTML' }
            );
            return;
        }

        const rank = parts[1] ? parseInt(parts[1]) : 1;
        if (isNaN(rank) || rank < 1 || rank > 10) {
            ctx.reply('❌ 池排名需介於 1 ~ 10 之間。');
            return;
        }

        // 依 APR 排序找第 rank 高的池
        const sorted = [...pools].sort(
            (a, b) => (b.apr + (b.farmApr ?? 0)) - (a.apr + (a.farmApr ?? 0))
        );
        const pool = sorted[rank - 1];
        if (!pool) {
            ctx.reply(`⚠️ 找不到第 ${rank} 高 APR 的池子資料。`);
            return;
        }

        const strategy = appState.strategies[pool.id.toLowerCase()];
        if (!strategy) {
            ctx.reply(
                `⏳ 第 ${rank} 高 APR 池（${pool.dex}）尚無 MC 策略\n\n` +
                `策略將在下一輪 cron 週期計算後可用，請稍後再試。`,
            );
            return;
        }

        const msg = buildStrategyReport(strategy, pool, capital);
        ctx.reply(msg, { parse_mode: 'HTML' });
    });
}
