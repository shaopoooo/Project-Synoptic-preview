import type { Bot } from 'grammy';
import { appState } from '../../infra/AppState';
import { isValidWalletAddress } from '../../infra/utils/validation';
import type { UserConfig } from '../../types';
import type { BotDeps } from './context';

export function registerWalletCommands(bot: Bot, deps: BotDeps): void {
    bot.command('wallet', async (ctx) => {
        const parts = (ctx.match?.trim() ?? '').split(/\s+/).filter(Boolean);
        const sub = parts[0]?.toLowerCase() ?? '';
        const addr = parts[1] ?? '';

        if (!sub || sub === 'list') {
            const wallets = appState.userConfig.wallets;
            if (wallets.length === 0) {
                ctx.reply('目前沒有設定任何錢包。\n用法: <code>/wallet add &lt;address&gt;</code>', { parse_mode: 'HTML' });
            } else {
                const list = wallets.map((w, i) => {
                    const posCount = w.positions.length;
                    return `${i + 1}. <code>${w.address}</code>  (${posCount} 個倉位配置)`;
                }).join('\n');
                ctx.reply(`👛 <b>監測錢包（${wallets.length} 個）</b>\n\n${list}`, { parse_mode: 'HTML' });
            }
            return;
        }

        if (sub === 'add') {
            if (!isValidWalletAddress(addr)) {
                ctx.reply('❌ 無效地址格式。請輸入 0x 開頭的 42 位十六進位地址。');
                return;
            }
            if (appState.userConfig.wallets.some(w => w.address.toLowerCase() === addr.toLowerCase())) {
                ctx.reply(`⚠️ 此錢包已在監測清單中: <code>${addr}</code>`, { parse_mode: 'HTML' });
                return;
            }
            const newCfg: UserConfig = {
                ...appState.userConfig,
                wallets: [...appState.userConfig.wallets, { address: addr, positions: [] }],
            };
            if (deps.onUserConfigChange) await deps.onUserConfigChange(newCfg);
            ctx.reply(`✅ 已新增錢包: <code>${addr}</code>\n（下個週期起開始掃描此錢包的倉位）`, { parse_mode: 'HTML' });
            return;
        }

        if (sub === 'rm') {
            if (!isValidWalletAddress(addr)) {
                ctx.reply('❌ 無效地址格式。');
                return;
            }
            const filtered = appState.userConfig.wallets.filter(
                w => w.address.toLowerCase() !== addr.toLowerCase()
            );
            if (filtered.length === appState.userConfig.wallets.length) {
                ctx.reply(`⚠️ 找不到此錢包: <code>${addr}</code>`, { parse_mode: 'HTML' });
                return;
            }
            const newCfg: UserConfig = { ...appState.userConfig, wallets: filtered };
            if (deps.onUserConfigChange) await deps.onUserConfigChange(newCfg);
            ctx.reply(`✅ 已移除錢包: <code>${addr}</code>（及其倉位配置）`, { parse_mode: 'HTML' });
            return;
        }

        ctx.reply('❌ 用法:\n/wallet — 列出錢包\n/wallet add &lt;address&gt;\n/wallet rm &lt;address&gt;', { parse_mode: 'HTML' });
    });
}
