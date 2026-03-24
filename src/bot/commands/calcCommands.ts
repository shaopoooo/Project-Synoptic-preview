import type { Bot } from 'grammy';
import { appState } from '../../utils/AppState';
import { calcOpenPosition } from '../../services/PositionCalculator';
import { buildCalcReport } from '../../utils/formatter';

export function registerCalcCommands(bot: Bot): void {
    bot.command('calc', async (ctx) => {
        const pools = appState.pools;
        if (pools.length === 0) {
            ctx.reply('⚠️ 尚無池子資料，請稍後再試。');
            return;
        }

        const parts = (ctx.match?.trim() ?? '').split(/\s+/).filter(Boolean);

        // 用法: /calc <capital> [rank] [lower%] [upper%]
        // e.g.: /calc 1.5          → 1.5 ETH，APR #1 池，BB 區間
        //       /calc 1.5 2        → APR #2 池
        //       /calc 1.5 1 5 5   → ±5% 自定區間

        const capital = parseFloat(parts[0] ?? '');
        if (!parts[0] || isNaN(capital) || capital <= 0) {
            ctx.reply(
                '📊 <b>開倉試算</b>\n\n' +
                '用法: <code>/calc &lt;資金 token0&gt; [池排名 1-5] [下限%] [上限%]</code>\n\n' +
                '範例:\n' +
                '<code>/calc 1.5</code>       — 1.5 ETH，APR 最高池，BB 區間\n' +
                '<code>/calc 1.5 2</code>     — APR 第 2 高池\n' +
                '<code>/calc 1.5 1 5 5</code> — 自定 ±5% 區間\n\n' +
                '📌 IL 以 token0（通常為 WETH/cbBTC）為本位計算',
                { parse_mode: 'HTML' }
            );
            return;
        }

        const rank = parts[1] ? parseInt(parts[1]) : 1;
        if (isNaN(rank) || rank < 1 || rank > 10) {
            ctx.reply('❌ 池排名需介於 1 ~ 10 之間。');
            return;
        }

        let lowerPct: number | null = null;
        let upperPct: number | null = null;
        if (parts[2] && parts[3]) {
            lowerPct = parseFloat(parts[2]);
            upperPct = parseFloat(parts[3]);
            if (isNaN(lowerPct) || isNaN(upperPct) || lowerPct <= 0 || upperPct <= 0) {
                ctx.reply('❌ 區間百分比需為正數，例如 <code>/calc 1.5 1 5 5</code>', { parse_mode: 'HTML' });
                return;
            }
        }

        // 告知使用者計算中（MC 模擬約 1–3 秒）
        await ctx.reply('⏳ 計算中，請稍候...');

        const result = await calcOpenPosition(capital, rank, lowerPct, upperPct, /* runMC= */ true);
        if (!result) {
            ctx.reply(`⚠️ 找不到第 ${rank} 高 APR 的池子資料。`);
            return;
        }

        const msg = buildCalcReport(result);
        ctx.reply(msg, { parse_mode: 'HTML' });
    });
}
