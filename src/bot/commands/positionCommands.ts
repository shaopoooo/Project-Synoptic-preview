import type { Bot } from 'grammy';
import { config } from '../../config';
import { appState, ucTrackedPositions, ucUpsertPosition, ucFindWallet } from '../../utils/AppState';
import { isValidWalletAddress } from '../../utils/validation';
import type { Dex } from '../../types';
import type { BotDeps } from './context';

const FMT = config.FMT;
export const dexList = config.VALID_DEXES.join(' / ');

export function registerPositionCommands(bot: Bot, deps: BotDeps): void {
    // ── /invest（合併 track 功能）────────────────────────────────────────
    bot.command('invest', async (ctx) => {
        const parts = (ctx.match?.trim() ?? '').split(/\s+/).filter(Boolean);

        // ── 列出所有倉位配置 ────────────────────────────────────────────
        if (parts.length === 0) {
            const lines: string[] = [];
            for (const wallet of appState.userConfig.wallets) {
                for (const pos of wallet.positions) {
                    if (pos.closed) continue;
                    if (pos.initial === 0 && !pos.externalStake) continue;
                    const wShort = `<code>${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}</code>`;
                    const inv = pos.initial > 0 ? `$${pos.initial.toFixed(FMT.USD_CENTS)}` : '未設定';
                    const track = pos.externalStake ? `🔒 ${pos.dexType}` : '';
                    lines.push(`${wShort} #<code>${pos.tokenId}</code>  本金 ${inv}  ${track}`.trimEnd());
                }
            }
            if (lines.length === 0) {
                ctx.reply(
                    `目前沒有倉位配置。\n\n` +
                    `用法: <code>/invest &lt;address&gt; &lt;tokenId&gt; &lt;amount&gt; &lt;dex&gt;</code>\n` +
                    `dex 可用值: ${dexList}`,
                    { parse_mode: 'HTML' }
                );
            } else {
                ctx.reply(`💰 <b>倉位配置（${lines.length} 筆，已關倉不顯示）</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
            }
            return;
        }

        if (parts.length < 4) {
            ctx.reply(
                `❌ 用法:\n` +
                `<code>/invest &lt;address&gt; &lt;tokenId&gt; &lt;amount&gt; &lt;dex&gt;</code>  設定本金 + 追蹤倉位\n` +
                `  amount=0 清除本金（保留追蹤）\n` +
                `  dex 可用值: ${dexList}`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        // ── 解析與驗證 ───────────────────────────────────────────────────
        const address = parts[0];
        const tokenId = parts[1];
        const amount = parseFloat(parts[2]);
        const dexArg = parts[3] as Dex;

        if (!isValidWalletAddress(address)) {
            ctx.reply('❌ 無效錢包地址（需為 0x 開頭的 42 位十六進位）');
            return;
        }
        if (isNaN(amount) || amount < 0) {
            ctx.reply('❌ amount 必須為 ≥ 0 的數字');
            return;
        }
        if (!config.VALID_DEXES.includes(dexArg)) {
            ctx.reply(`❌ 無效 DEX「${dexArg}」\n可用值: ${dexList}`);
            return;
        }
        if (!appState.userConfig.wallets.some(w => w.address.toLowerCase() === address.toLowerCase())) {
            ctx.reply(`❌ 找不到錢包 <code>${address}</code>，請先用 /wallet add 新增`, { parse_mode: 'HTML' });
            return;
        }

        // ── Upsert ───────────────────────────────────────────────────────
        const newCfg = ucUpsertPosition(appState.userConfig, address, tokenId, {
            initial: amount,
            dexType: dexArg,
            externalStake: true,
        });
        if (deps.onUserConfigChange) await deps.onUserConfigChange(newCfg);

        // ── 確認訊息 ─────────────────────────────────────────────────────
        const wShort = `${address.slice(0, 6)}…${address.slice(-4)}`;
        const invMsg = amount > 0 ? `本金 <b>$${amount.toFixed(FMT.USD_CENTS)}</b>` : '本金已清除';
        ctx.reply(`✅ #${tokenId} (${wShort})  ${invMsg}  🔒 externalStake=${dexArg}`, { parse_mode: 'HTML' });
    });

    // ── /stake ────────────────────────────────────────────────────────────
    bot.command('stake', async (ctx) => {
        const parts = (ctx.match?.trim() ?? '').split(/\s+/).filter(Boolean);

        if (parts.length === 0) {
            const staked = ucTrackedPositions(appState.userConfig);
            if (staked.length === 0) {
                ctx.reply(
                    `目前沒有外部質押倉位。\n\n` +
                    `用法: <code>/stake &lt;address&gt; &lt;tokenId&gt; &lt;dex&gt;</code>\n` +
                    `dex 可用值: ${dexList}`,
                    { parse_mode: 'HTML' }
                );
            } else {
                const list = staked.map(t =>
                    `#<code>${t.tokenId}</code>  ${t.dexType}  <code>${t.ownerWallet.slice(0, 6)}…${t.ownerWallet.slice(-4)}</code>`
                ).join('\n');
                ctx.reply(`🔒 <b>外部質押倉位（${staked.length} 個）</b>\n\n${list}\n\n取消: <code>/unstake &lt;tokenId&gt;</code>`, { parse_mode: 'HTML' });
            }
            return;
        }

        if (parts.length < 3) {
            ctx.reply(
                `❌ 用法: <code>/stake &lt;address&gt; &lt;tokenId&gt; &lt;dex&gt;</code>\n` +
                `dex 可用值: ${dexList}`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        const address = parts[0];
        const tokenId = parts[1];
        const dexArg = parts[2] as Dex;

        if (!isValidWalletAddress(address)) {
            ctx.reply('❌ 無效錢包地址（需為 0x 開頭的 42 位十六進位）');
            return;
        }
        if (!config.VALID_DEXES.includes(dexArg)) {
            ctx.reply(`❌ 無效 DEX「${dexArg}」\n可用值: ${dexList}`);
            return;
        }
        if (!appState.userConfig.wallets.some(w => w.address.toLowerCase() === address.toLowerCase())) {
            ctx.reply(`❌ 找不到錢包 <code>${address}</code>，請先用 /wallet add 新增`, { parse_mode: 'HTML' });
            return;
        }

        const newCfg = ucUpsertPosition(appState.userConfig, address, tokenId, {
            dexType: dexArg,
            externalStake: true,
        });
        if (deps.onUserConfigChange) await deps.onUserConfigChange(newCfg);
        const wShort = `${address.slice(0, 6)}…${address.slice(-4)}`;
        ctx.reply(`✅ #${tokenId} (${wShort}) 已標記為外部質押 🔒 ${dexArg}`, { parse_mode: 'HTML' });
    });

    // ── /unstake ──────────────────────────────────────────────────────────
    bot.command('unstake', async (ctx) => {
        const tokenId = ctx.match?.trim() ?? '';
        if (!tokenId) {
            const staked = ucTrackedPositions(appState.userConfig);
            if (staked.length === 0) {
                ctx.reply(`目前沒有外部質押倉位。\n用法: <code>/stake &lt;address&gt; &lt;tokenId&gt; &lt;dex&gt;</code>`, { parse_mode: 'HTML' });
            } else {
                const list = staked.map(t =>
                    `#<code>${t.tokenId}</code>  ${t.dexType}  <code>${t.ownerWallet.slice(0, 6)}…${t.ownerWallet.slice(-4)}</code>`
                ).join('\n');
                ctx.reply(`🔒 <b>外部質押倉位（${staked.length} 個）</b>\n\n${list}\n\n用法: <code>/unstake &lt;tokenId&gt;</code>`, { parse_mode: 'HTML' });
            }
            return;
        }
        if (!deps.positionScanner) {
            ctx.reply('❌ PositionScanner 尚未初始化');
            return;
        }
        const result = await deps.positionScanner.unstake(tokenId);
        if (result.status === 'not_found') {
            ctx.reply(`⚠️ #${tokenId} 不在質押清單中`);
            return;
        }
        if (result.status === 'still_staked') {
            ctx.reply(`⚠️ #${tokenId} NFT 仍在 Gauge（<code>${result.owner.slice(0, 10)}…</code>），無法取消追蹤。\n請先在鏈上 unstake 後再執行此指令。`, { parse_mode: 'HTML' });
            return;
        }
        if (result.status === 'chain_error') {
            ctx.reply(`⚠️ #${tokenId} 鏈上確認失敗，已略過檢查並取消質押標記。`);
        } else if (result.status === 'closed') {
            ctx.reply(`✅ #${tokenId} 已取消質押標記，liquidity=0 → 自動標記為已關倉`);
            return;
        } else {
            ctx.reply(`✅ #${tokenId} 已取消外部質押標記，下次掃描將從錢包重新追蹤`);
        }
        if (deps.onUserConfigChange) await deps.onUserConfigChange(appState.userConfig);
    });

    // ── /capital ──────────────────────────────────────────────────────────
    bot.command('capital', async (ctx) => {
        const parts = (ctx.match?.trim() ?? '').split(/\s+/).filter(Boolean);

        if (parts.length === 0) {
            const lines: string[] = [];
            for (const wallet of appState.userConfig.wallets) {
                for (const pos of wallet.positions) {
                    if (pos.closed || pos.initial === 0) continue;
                    const wShort = `<code>${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}</code>`;
                    lines.push(`${wShort} #<code>${pos.tokenId}</code>  本金 <b>$${pos.initial.toFixed(FMT.USD_CENTS)}</b>`);
                }
            }
            if (lines.length === 0) {
                ctx.reply('目前沒有設定本金的倉位。\n用法: <code>/capital &lt;tokenId&gt; &lt;amount&gt;</code>', { parse_mode: 'HTML' });
            } else {
                ctx.reply(`💰 <b>本金設定（${lines.length} 筆）</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
            }
            return;
        }

        if (parts.length < 2) {
            ctx.reply('❌ 用法: <code>/capital &lt;tokenId&gt; &lt;amount&gt;</code>\n  amount=0 清除本金', { parse_mode: 'HTML' });
            return;
        }

        const tokenId = parts[0];
        const amount = parseFloat(parts[1]);
        if (isNaN(amount) || amount < 0) {
            ctx.reply('❌ amount 必須為 ≥ 0 的數字');
            return;
        }

        const walletAddr = ucFindWallet(appState.userConfig, tokenId);
        if (!walletAddr) {
            ctx.reply(`❌ #${tokenId} 不在任何錢包的追蹤清單中`);
            return;
        }

        const newCfg = ucUpsertPosition(appState.userConfig, walletAddr, tokenId, { initial: amount });
        if (deps.onUserConfigChange) await deps.onUserConfigChange(newCfg);

        const msg = amount > 0 ? `本金已設為 <b>$${amount.toFixed(FMT.USD_CENTS)}</b>` : '本金已清除';
        ctx.reply(`✅ #${tokenId}  ${msg}`, { parse_mode: 'HTML' });
    });
}
