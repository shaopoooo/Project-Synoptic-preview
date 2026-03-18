import { Bot } from 'grammy';
import { config } from '../config';
import { PoolStats, BBResult, PositionRecord, RiskAnalysis, SortBy, Dex, UserConfig, PoolConfig } from '../types';
import { createServiceLogger } from '../utils/logger';
import { getTokenPrices } from '../utils/tokenPrices';
import { buildTelegramPositionBlock, fmtInterval } from '../utils/formatter';
import { appState, ucTrackedPositions, ucUpsertPosition, ucFindWallet, ucPoolList } from '../utils/AppState';
import { isValidWalletAddress, isValidPoolAddress, isValidPoolV4Id } from '../utils/validation';
import { calculateCapitalEfficiency } from '../utils/math';
import type { PositionScanner } from '../services/PositionScanner';

const log = createServiceLogger('TelegramBot');

/** 允許的排程間隔（分鐘）：10 的倍數且能整除 1440，起始對齊每日 00:00 */
export const VALID_INTERVALS = [10, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440] as const;
export type IntervalMinutes = typeof VALID_INTERVALS[number];

export function minutesToCron(min: number): string {
    if (min < 60) return `*/${min} * * * *`;
    if (min === 1440) return `0 0 * * *`;
    return `0 */${min / 60} * * *`;
}

export class TelegramBotService {
    private bot: Bot;
    private chatId: string;
    private onReschedule: ((minutes: number) => void) | null = null;
    private onUserConfigChange: ((cfg: UserConfig) => Promise<void>) | null = null;
    private positionScanner!: PositionScanner;

    setPositionScanner(scanner: PositionScanner) {
        this.positionScanner = scanner;
    }

    setRescheduleCallback(cb: (minutes: number) => void) {
        this.onReschedule = cb;
    }

    /** 設定 userConfig 變更時的回呼（更新 appState 並持久化）。 */
    setUserConfigChangeCallback(cb: (cfg: UserConfig) => Promise<void>) {
        this.onUserConfigChange = cb;
    }

    constructor() {
        this.bot = new Bot(config.BOT_TOKEN);
        this.chatId = config.CHAT_ID;

        this.bot.command('start', (ctx) => {
            ctx.reply('DexInfoBot started! Monitoring Base network DEX pools...');
        });

        this.bot.command('help', (ctx) => {
            const msg =
                `📋 <b>DexInfoBot 指令說明</b>\n\n` +
                `<b>📊 報告與排序</b>\n` +
                `/sort &lt;key&gt; — 設定倉位排序方式\n` +
                `  · <code>size</code>　倉位大小（預設）\n` +
                `  · <code>apr</code>　　池子 APR\n` +
                `  · <code>unclaimed</code> 未領取手續費\n` +
                `  · <code>health</code>　健康分數\n\n` +
                `<b>⏱ 排程</b>\n` +
                `/interval &lt;分鐘&gt; — 設定自動報告間隔\n` +
                `  可用值: ${VALID_INTERVALS.map(m => fmtInterval(m)).join('、')}\n` +
                `  範例: <code>/interval 30</code>\n\n` +
                `<b>📐 BB 布林通道</b>\n` +
                `/bbk — 查看目前 k 值設定\n` +
                `/bbk &lt;low&gt; &lt;high&gt; — 調整 BB 帶寬乘數\n` +
                `  建議範圍 1.0 ~ 3.0，預設 ${config.BB_K_LOW_VOL}/${config.BB_K_HIGH_VOL}\n` +
                `  範例: <code>/bbk 1.8 2.5</code>\n\n` +
                `<b>👛 錢包管理</b>\n` +
                `/wallet — 列出目前監測的錢包\n` +
                `/wallet add &lt;address&gt; — 新增錢包\n` +
                `/wallet rm &lt;address&gt; — 移除錢包\n\n` +
                `<b>🔀 DEX</b>\n` +
                `/dex — 列出所有支援的 DEX\n\n` +
                `<b>🏊 池清單</b>\n` +
                `/pool — 列出監測池\n` +
                `/pool add &lt;address&gt; &lt;dex&gt; &lt;fee%&gt; — 新增池\n` +
                `/pool rm &lt;address&gt; — 移除池\n\n` +
                `<b>💰 本金</b>\n` +
                `/capital — 列出所有本金設定\n` +
                `/capital &lt;tokenId&gt; &lt;amount&gt; — 設定/更新本金（不需地址）\n\n` +
                `<b>🔒 外部質押倉位</b>\n` +
                `/stake — 列出所有外部質押倉位\n` +
                `/stake &lt;address&gt; &lt;tokenId&gt; &lt;dex&gt; — 標記倉位為外部質押（Gauge/MasterChef）\n` +
                `/unstake &lt;tokenId&gt; — 取消外部質押標記\n` +
                `  dex 可用值: ${dexList}\n\n` +
                `<b>💼 倉位配置（合併設定）</b>\n` +
                `/invest — 列出所有倉位配置\n` +
                `/invest &lt;address&gt; &lt;tokenId&gt; &lt;amount&gt; &lt;dex&gt; — 同時設定本金 + 外部質押\n` +
                `  dex 可用值: ${dexList}\n\n` +
                `<b>📖 說明</b>\n` +
                `/explain — 各項指標計算公式詳解\n` +
                `/help — 顯示本說明`;
            ctx.reply(msg, { parse_mode: 'HTML' });
        });

        this.bot.command('sort', async (ctx) => {
            const key = (ctx.match?.trim() ?? '') as SortBy;
            const valid = Object.keys(config.SORT_LABELS) as SortBy[];
            if (valid.includes(key)) {
                const newCfg = { ...appState.userConfig, sortBy: key };
                if (this.onUserConfigChange) await this.onUserConfigChange(newCfg);
                ctx.reply(`✅ 排序已設為: <b>${config.SORT_LABELS[key]}</b> ↓`, { parse_mode: 'HTML' });
            } else {
                const currentSortBy = appState.userConfig.sortBy ?? 'size';
                ctx.reply(
                    `排序選項:\n` +
                    valid.map(k => `  /sort ${k} — ${config.SORT_LABELS[k]}`).join('\n') +
                    `\n\n目前排序: <b>${config.SORT_LABELS[currentSortBy]}</b>`,
                    { parse_mode: 'HTML' }
                );
            }
        });

        this.bot.command('explain', (ctx) => {
            const msg =
                `📖 <b>指標計算說明</b>\n\n` +
                `<b>淨損益（PnL）</b>\n` +
                `= LP現值 + Unclaimed - 初始本金\n` +
                `正值 🟢 = 盈利，負值 🔴 = 虧損\n\n` +
                `<b>無常損失（IL）</b>\n` +
                `= LP現值 - 初始本金\n` +
                `純市價波動造成的倉位縮水，不含手續費收益\n\n` +
                `<b>健康分數</b> (0–100)\n` +
                `= 50 + (Unclaimed + IL) / 本金 × 1000\n` +
                `50 = 損益兩平；&gt;50 盈利；&lt;50 虧損\n` +
                `100 = 報酬率達 +5% 以上\n\n` +
                `<b>Breakeven 天數</b>\n` +
                `= |IL| / 每日手續費收入\n` +
                `需幾天費用收益才能彌補目前 IL\n` +
                `IL ≥ 0 時顯示「盈利中」\n\n` +
                `<b>Compound Threshold (EOQ)</b>\n` +
                `= √(2 × 本金 × Gas費 × 24h費率)\n` +
                `Unclaimed ✅ &gt; Threshold → 建議複利再投入\n` +
                `Unclaimed ❌ &lt; Threshold → 繼續等待累積\n\n` +
                `<b>獲利率</b>\n` +
                `= (LP現值 + Unclaimed - 本金) / 本金 × 100%\n` +
                `需設定初始本金（<code>/invest &lt;address&gt; &lt;tokenId&gt; &lt;amount&gt; &lt;dex&gt;</code>）才顯示\n\n` +
                `<b>布林通道 BB（Bollinger Bands）</b>\n` +
                `SMA = 最近 20 筆小時 tick 均價\n` +
                `帶寬 = k × σ（stdDev，EWMA 平滑）\n` +
                `震盪市（Low Vol）: k_low；趨勢市（High Vol）: k_high\n` +
                `用 /bbk 調整，目前 k=${appState.bbKLowVol}/${appState.bbKHighVol}\n\n` +
                `<b>DRIFT 警告</b>\n` +
                `重疊度 = 你的倉位區間落在 BB 內的比例\n` +
                `&lt; ${config.DRIFT_WARNING_PCT}% 時觸發，建議依 BB 重建倉\n\n` +
                `<b>再平衡策略</b>\n` +
                `等待回歸 — 偏離小，無需行動\n` +
                `DCA 定投 — 偏離中，用手續費補倉\n` +
                `撤資單邊建倉 — 偏離大，單幣掛單等回歸\n\n` +
                `<b>區間 APR（In-Range APR）</b>\n` +
                `= 池子全範 APR × 資金效率乘數\n` +
                `資金效率 = 1 / (√(BB上軌/SMA) - √(BB下軌/SMA))\n` +
                `BB 區間越窄 → 效率越高 → 區間 APR 越大\n` +
                `僅在 BB 非 fallback 時顯示；報告與池排行均呈現`;
            ctx.reply(msg, { parse_mode: 'HTML' });
        });

        this.bot.command('interval', async (ctx) => {
            const raw = ctx.match?.trim() ?? '';
            if (!raw) {
                const opts = VALID_INTERVALS.map(m => `  /interval ${m} — ${fmtInterval(m)}`).join('\n');
                ctx.reply(`⏱ 排程間隔設定\n\n可用選項:\n${opts}`, { parse_mode: 'HTML' });
                return;
            }
            const min = parseInt(raw, 10);
            if (!VALID_INTERVALS.includes(min as IntervalMinutes)) {
                const opts = VALID_INTERVALS.map(m => `${fmtInterval(m)}`).join('、');
                ctx.reply(`❌ 無效間隔。可用值: ${opts}`);
                return;
            }
            if (this.onReschedule) {
                this.onReschedule(min);
                const newCfg = { ...appState.userConfig, intervalMinutes: min };
                if (this.onUserConfigChange) await this.onUserConfigChange(newCfg);
                ctx.reply(`✅ 排程已更新為每 <b>${fmtInterval(min)}</b> 執行一次\n（cron: <code>${minutesToCron(min)}</code>）`, { parse_mode: 'HTML' });
            } else {
                ctx.reply('❌ 排程功能尚未初始化');
            }
        });

        this.bot.command('bbk', async (ctx) => {
            const parts = (ctx.match?.trim() ?? '').split(/\s+/).filter(Boolean);
            if (parts.length === 0) {
                const { bbKLowVol, bbKHighVol } = appState;
                ctx.reply(
                    `📐 <b>BB k 值設定</b>\n\n` +
                    `目前: k_low=<b>${bbKLowVol}</b>  k_high=<b>${bbKHighVol}</b>\n\n` +
                    `用法: <code>/bbk &lt;low&gt; &lt;high&gt;</code>\n` +
                    `範例: <code>/bbk 1.8 2.5</code>\n\n` +
                    `震盪市 (Low Vol) 用 k_low，趨勢市 (High Vol) 用 k_high。\n` +
                    `建議範圍：1.0 ~ 3.0`,
                    { parse_mode: 'HTML' }
                );
                return;
            }
            if (parts.length !== 2) {
                ctx.reply('❌ 格式錯誤。用法: <code>/bbk &lt;low&gt; &lt;high&gt;</code>', { parse_mode: 'HTML' });
                return;
            }
            const kLow = parseFloat(parts[0]);
            const kHigh = parseFloat(parts[1]);
            if (isNaN(kLow) || isNaN(kHigh) || kLow <= 0 || kHigh <= 0 || kLow > kHigh) {
                ctx.reply('❌ 數值無效。low 與 high 需為正數且 low ≤ high');
                return;
            }
            appState.bbKLowVol = kLow;
            appState.bbKHighVol = kHigh;
            const newCfg = { ...appState.userConfig, bbKLowVol: kLow, bbKHighVol: kHigh };
            if (this.onUserConfigChange) await this.onUserConfigChange(newCfg);
            ctx.reply(
                `✅ BB k 值已更新\nk_low=<b>${kLow}</b>  k_high=<b>${kHigh}</b>\n（下個週期生效）`,
                { parse_mode: 'HTML' }
            );
        });

        // ── /dex ──────────────────────────────────────────────────────────────
        this.bot.command('dex', (ctx) => {
            const list = config.VALID_DEXES.map(d => `  · <code>${d}</code>`).join('\n');
            ctx.reply(`🔀 <b>支援的 DEX</b>\n\n${list}`, { parse_mode: 'HTML' });
        });

        // ── /wallet ───────────────────────────────────────────────────────────
        this.bot.command('wallet', async (ctx) => {
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
                    wallets: [...appState.userConfig.wallets, { address: addr, positions: [] }],
                };
                if (this.onUserConfigChange) await this.onUserConfigChange(newCfg);
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
                const newCfg: UserConfig = { wallets: filtered };
                if (this.onUserConfigChange) await this.onUserConfigChange(newCfg);
                ctx.reply(`✅ 已移除錢包: <code>${addr}</code>（及其倉位配置）`, { parse_mode: 'HTML' });
                return;
            }

            ctx.reply('❌ 用法:\n/wallet — 列出錢包\n/wallet add &lt;address&gt;\n/wallet rm &lt;address&gt;', { parse_mode: 'HTML' });
        });

        // ── /pool（池清單管理）──────────────────────────────────────────────
        this.bot.command('pool', async (ctx) => {
            const parts = (ctx.match?.trim() ?? '').split(/\s+/).filter(Boolean);
            const sub = parts[0]?.toLowerCase() ?? '';

            const effectivePools = ucPoolList(appState.userConfig);
            const isCustomized = !!(appState.userConfig.pools && appState.userConfig.pools.length > 0);

            if (!sub || sub === 'list') {
                const lines = effectivePools.map((p, i) => {
                    const feePct = `${(p.fee * 100).toFixed(4).replace(/\.?0+$/, '')}%`;
                    const addrShort = `${p.address.slice(0, 10)}…`;
                    return `${i + 1}. ${p.dex} ${feePct}  <code>${addrShort}</code>`;
                });
                const src = isCustomized ? '（自訂）' : '（預設）';
                ctx.reply(
                    `🏊 <b>監測池清單 ${src}</b>\n\n${lines.join('\n')}\n\n` +
                    `用法:\n/pool add &lt;address&gt; &lt;dex&gt; &lt;fee%&gt;\n/pool rm &lt;address&gt;`,
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
                if (this.onUserConfigChange) await this.onUserConfigChange(newCfg);
                const feePct = `${(feeNum * 100).toFixed(4).replace(/\.?0+$/, '')}%`;
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
                if (this.onUserConfigChange) await this.onUserConfigChange(newCfg);
                ctx.reply(`✅ 已移除池: <code>${addr.slice(0, 20)}…</code>`, { parse_mode: 'HTML' });
                return;
            }

            ctx.reply(
                '❌ 用法:\n/pool — 列出池清單\n/pool add &lt;address&gt; &lt;dex&gt; &lt;fee%&gt;\n/pool rm &lt;address&gt;',
                { parse_mode: 'HTML' }
            );
        });

        // ── /invest（合併 track 功能）────────────────────────────────────────
        const dexList = config.VALID_DEXES.join(' / ');

        this.bot.command('invest', async (ctx) => {
            const parts = (ctx.match?.trim() ?? '').split(/\s+/).filter(Boolean);

            // ── 列出所有倉位配置 ────────────────────────────────────────────
            if (parts.length === 0) {
                const lines: string[] = [];
                for (const wallet of appState.userConfig.wallets) {
                    for (const pos of wallet.positions) {
                        if (pos.closed) continue;
                        if (pos.initial === 0 && !pos.externalStake) continue;
                        const wShort = `<code>${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}</code>`;
                        const inv = pos.initial > 0 ? `$${pos.initial.toFixed(2)}` : '未設定';
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
            if (this.onUserConfigChange) await this.onUserConfigChange(newCfg);

            // ── 確認訊息 ─────────────────────────────────────────────────────
            const wShort = `${address.slice(0, 6)}…${address.slice(-4)}`;
            const invMsg = amount > 0 ? `本金 <b>$${amount.toFixed(2)}</b>` : '本金已清除';
            ctx.reply(`✅ #${tokenId} (${wShort})  ${invMsg}  🔒 externalStake=${dexArg}`, { parse_mode: 'HTML' });
        });

        // ── /stake ────────────────────────────────────────────────────────────
        this.bot.command('stake', async (ctx) => {
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
            if (this.onUserConfigChange) await this.onUserConfigChange(newCfg);
            const wShort = `${address.slice(0, 6)}…${address.slice(-4)}`;
            ctx.reply(`✅ #${tokenId} (${wShort}) 已標記為外部質押 🔒 ${dexArg}`, { parse_mode: 'HTML' });
        });

        // ── /unstake ──────────────────────────────────────────────────────────
        this.bot.command('unstake', async (ctx) => {
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
            const result = await this.positionScanner.unstake(tokenId);
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
            if (this.onUserConfigChange) await this.onUserConfigChange(appState.userConfig);
        });

        // ── /capital ──────────────────────────────────────────────────────────
        this.bot.command('capital', async (ctx) => {
            const parts = (ctx.match?.trim() ?? '').split(/\s+/).filter(Boolean);

            if (parts.length === 0) {
                const lines: string[] = [];
                for (const wallet of appState.userConfig.wallets) {
                    for (const pos of wallet.positions) {
                        if (pos.closed || pos.initial === 0) continue;
                        const wShort = `<code>${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}</code>`;
                        lines.push(`${wShort} #<code>${pos.tokenId}</code>  本金 <b>$${pos.initial.toFixed(2)}</b>`);
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
            if (this.onUserConfigChange) await this.onUserConfigChange(newCfg);

            const msg = amount > 0 ? `本金已設為 <b>$${amount.toFixed(2)}</b>` : '本金已清除';
            ctx.reply(`✅ #${tokenId}  ${msg}`, { parse_mode: 'HTML' });
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
        const TELEGRAM_MAX_LEN = 4096;
        const chunks: string[] = [];
        if (message.length <= TELEGRAM_MAX_LEN) {
            chunks.push(message);
        } else {
            // Split on newlines, never mid-tag
            const lines = message.split('\n');
            let current = '';
            for (const line of lines) {
                const candidate = current ? `${current}\n${line}` : line;
                if (candidate.length > TELEGRAM_MAX_LEN) {
                    if (current) chunks.push(current);
                    current = line;
                } else {
                    current = candidate;
                }
            }
            if (current) chunks.push(current);
            log.warn(`Message split into ${chunks.length} parts (original ${message.length} chars)`);
        }
        for (const chunk of chunks) {
            await this.bot.api.sendMessage(this.chatId, chunk, { parse_mode: 'HTML' });
        }
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
        const fmtUSD = (v: number) => v >= 0 ? `+$${v.toFixed(1)}` : `-$${Math.abs(v).toFixed(1)}`;

        let msg = `<b>[${timeStr}] 倉位監控報告 (${sorted.length} 個倉位 | 排序: ${config.SORT_LABELS[sortBy]} ↓)</b>`;
        msg += `\n\n📊 <b>總覽</b>  ${entries.length} 倉位 · ${walletCount} 錢包`;
        msg += `\n💼 總倉位 <b>$${totalPositionUSD.toFixed(0)}</b>  |  本金 <b>$${totalInitialCapital.toFixed(0)}</b>  |  Unclaimed <b>$${totalUnclaimedUSD.toFixed(1)}</b>`;

        // 即時幣價（由獨立 tokenPrices 模組提供，不依賴 BBEngine 是否成功）
        const tp = getTokenPrices();
        const p = (v: number, d: number) => v > 0 ? `$${v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}` : '–';
        msg += `\n💱 ETH ${p(tp.ethPrice, 0)}  BTC ${p(tp.cbbtcPrice, 0)}  CAKE ${p(tp.cakePrice, 3)}  AERO ${p(tp.aeroPrice, 3)}`;

        if (totalPnL !== null) {
            const icon = totalPnL >= 0 ? '🟢' : '🔴';
            const pctStr = totalPnLPct !== null
                ? ` (${totalPnLPct >= 0 ? '+' : ''}${totalPnLPct.toFixed(2)}%)`
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
                const label = `${p.dex} ${(p.feeTier * 100).toFixed(4).replace(/\.?0+$/, '')}%`;
                const feeAprPct = (p.apr * 100).toFixed(2);
                const totalApr = p.apr + (p.farmApr ?? 0);
                const aprStr = p.farmApr !== undefined
                    ? `APR <b>${(totalApr * 100).toFixed(2)}%</b>(手續費${feeAprPct}%+農場${(p.farmApr * 100).toFixed(2)}%)`
                    : `APR <b>${feeAprPct}%</b>`;
                const tvl = p.tvlUSD >= 1000 ? `$${(p.tvlUSD / 1000).toFixed(0)}K` : `$${p.tvlUSD.toFixed(0)}`;
                const tag = activePoolIds.has(p.id.toLowerCase()) ? ' ◀ 你的倉位' : '';
                const bb = appState.bbs[p.id.toLowerCase()];
                let inRangeTag = '';
                if (bb && !bb.isFallback && bb.sma > 0) {
                    const eff = calculateCapitalEfficiency(bb.upperPrice, bb.lowerPrice, bb.sma);
                    if (eff !== null) {
                        inRangeTag = ` → 區間 <b>${(totalApr * eff * 100).toFixed(1)}%</b>`;
                    }
                }
                msg += `\n${rank} ${label} — ${aprStr}${inRangeTag} | TVL ${tvl}${tag}`;
            });
        }

        // BB k 值與更新時間
        msg += `\n\n⌛ <b>資料更新時間:</b>`;
        msg += `\n- Pool: ${formatTs(lastUpdates.poolScanner)} | Position: ${formatTs(lastUpdates.positionScanner)}`;
        msg += `\n- BB Engine: ${formatTs(lastUpdates.bbEngine)} | Risk: ${formatTs(lastUpdates.riskManager)}`;
        msg += `\n📐 BB k: low=<b>${appState.bbKLowVol}</b>  high=<b>${appState.bbKHighVol}</b>`;

        await this.sendAlert(msg);
    }
}
