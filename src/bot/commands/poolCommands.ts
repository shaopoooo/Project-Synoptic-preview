import type { Bot } from 'grammy';
import { config } from '../../config';
import { appState, ucPoolList } from '../../utils/AppState';
import { isValidPoolAddress, isValidPoolV4Id } from '../../utils/validation';
import type { Dex, PoolConfig } from '../../types';
import type { BotDeps } from './context';

const FMT = config.FMT;

export function registerPoolCommands(bot: Bot, deps: BotDeps): void {
    bot.command('pool', async (ctx) => {
        const parts = (ctx.match?.trim() ?? '').split(/\s+/).filter(Boolean);
        const sub = parts[0]?.toLowerCase() ?? '';

        const effectivePools = ucPoolList(appState.userConfig);
        const isCustomized = !!(appState.userConfig.pools && appState.userConfig.pools.length > 0);

        if (!sub || sub === 'list') {
            const lines = effectivePools.map((p, i) => {
                const feePct = `${(p.fee * 100).toFixed(FMT.FEE_TIER).replace(/\.?0+$/, '')}%`;
                const addrShort = `${p.address.slice(0, 10)}…`;
                return `${i + 1}. ${p.dex} ${feePct}  <code>${addrShort}</code>`;
            });
            const src = isCustomized ? '（自訂）' : '（預設）';
            ctx.reply(
                `🏊 <b>監測池清單 ${src}</b>\n\n${lines.join('\n')}\n\n` +
                `用法:\n/pool add &lt;address&gt; &lt;dex&gt; &lt;fee%&gt;\n/pool rm &lt;address&gt;\n\n` +
                `fee% 請輸入百分比數字，例如 <code>0.05</code> 代表 0.05%（= 5 bps）`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        if (sub === 'add') {
            const addr = parts[1] ?? '';
            const dex = parts[2] as Dex | undefined;
            const feeRaw = parts[3] ?? '';

            if (!isValidPoolAddress(addr) && !isValidPoolV4Id(addr)) {
                ctx.reply('❌ 無效地址格式。V3 需 42 位，V4 poolId 需 66 位（bytes32）。');
                return;
            }
            if (!dex || !config.VALID_DEXES.includes(dex)) {
                ctx.reply(`❌ 無效 DEX。可用值: ${config.VALID_DEXES.join(' / ')}`);
                return;
            }
            const feeNum = parseFloat(feeRaw) / 100;
            if (!feeRaw || isNaN(feeNum) || feeNum <= 0) {
                ctx.reply('❌ 無效費率。請輸入百分比，如 <code>0.3</code> 代表 0.3%', { parse_mode: 'HTML' });
                return;
            }
            const addrLower = addr.toLowerCase();
            if (effectivePools.some(p => p.address.toLowerCase() === addrLower)) {
                ctx.reply(`⚠️ 此池已在清單中: <code>${addr.slice(0, 20)}…</code>`, { parse_mode: 'HTML' });
                return;
            }
            const newPool: PoolConfig = { address: addr, dex, fee: feeNum };
            const newPools = [...effectivePools, newPool];
            const newCfg = { ...appState.userConfig, pools: newPools };
            if (deps.onUserConfigChange) await deps.onUserConfigChange(newCfg);
            const feePct = `${(feeNum * 100).toFixed(FMT.FEE_TIER).replace(/\.?0+$/, '')}%`;
            ctx.reply(`✅ 已新增池: ${dex} ${feePct}\n<code>${addr}</code>`, { parse_mode: 'HTML' });
            return;
        }

        if (sub === 'rm') {
            const addr = parts[1] ?? '';
            if (!addr) {
                ctx.reply('❌ 用法: /pool rm &lt;address&gt;', { parse_mode: 'HTML' });
                return;
            }
            const addrLower = addr.toLowerCase();
            const filtered = effectivePools.filter(p => p.address.toLowerCase() !== addrLower);
            if (filtered.length === effectivePools.length) {
                ctx.reply(`⚠️ 找不到此池: <code>${addr.slice(0, 20)}…</code>`, { parse_mode: 'HTML' });
                return;
            }
            const newCfg = { ...appState.userConfig, pools: filtered };
            if (deps.onUserConfigChange) await deps.onUserConfigChange(newCfg);
            ctx.reply(`✅ 已移除池: <code>${addr.slice(0, 20)}…</code>`, { parse_mode: 'HTML' });
            return;
        }

        ctx.reply(
            '❌ 用法:\n/pool — 列出池清單\n/pool add &lt;address&gt; &lt;dex&gt; &lt;fee%&gt;\n/pool rm &lt;address&gt;',
            { parse_mode: 'HTML' }
        );
    });
}
