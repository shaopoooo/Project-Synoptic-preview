import type { Bot } from 'grammy';
import { config } from '../../config';
import { appState } from '../../utils/AppState';
import { fmtInterval } from '../../utils/formatter';
import { VALID_INTERVALS } from './context';

// dexList is needed for help text
const dexList = config.VALID_DEXES.join(' / ');

export function registerInfoCommands(bot: Bot): void {
    bot.command('start', (ctx) => {
        ctx.reply('DexInfoBot started! Monitoring Base network DEX pools...');
    });

    bot.command('help', (ctx) => {
        const msg =
            `📋 <b>DexInfoBot 指令說明</b>\n\n` +
            `<b>📊 報告與排序</b>\n` +
            `/sort &lt;key&gt; — 設定倉位排序方式\n` +
            `  · <code>size</code>　倉位大小（預設）\n` +
            `  · <code>apr</code>　　池子 APR\n` +
            `  · <code>unclaimed</code> 未領取\n` +
            `  · <code>health</code>　健康分數\n\n` +
            `<b>⏱ 排程</b>\n` +
            `/interval &lt;分鐘&gt; — 設定掃描間隔\n` +
            `  可用值: ${VALID_INTERVALS.map(m => fmtInterval(m)).join('、')}\n` +
            `  範例: <code>/interval 30</code>\n` +
            `/report — 查看快訊 / 完整報告排程設定\n` +
            `/report flash &lt;分鐘&gt; — 設定快訊間隔（須 ≥ 掃描間隔，10 倍數）\n` +
            `/report full &lt;分鐘&gt; — 設定完整報告間隔（須 ≥ 快訊間隔，10 倍數）\n\n` +
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
            `<b>🖥 顯示設定</b>\n` +
            `/compact — 切換簡化訊息模式（toggle）\n` +
            `/config — 顯示所有當前設定值\n\n` +
            `<b>📖 說明</b>\n` +
            `/explain — 各項指標計算公式詳解\n` +
            `/help — 顯示本說明`;
        ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.command('explain', (ctx) => {
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
            `= √(2 × 倉位現值 × Gas費)\n` +
            `最佳複利間隔 = Threshold ÷ 日費收入（天數）\n` +
            `Unclaimed ✅ &gt; Threshold → 建議複利再投入\n` +
            `Unclaimed ❌ &lt; Threshold → 繼續等待累積\n\n` +
            `<b>獲利率</b>\n` +
            `= (LP現值 + Unclaimed - 本金) / 本金 × 100%\n` +
            `需設定初始本金（<code>/invest &lt;address&gt; &lt;tokenId&gt; &lt;amount&gt; &lt;dex&gt;</code>）才顯示\n\n` +
            `<b>布林通道 BB（Bollinger Bands）</b>\n` +
            `SMA = 最近 20 筆小時 tick 均價\n` +
            `帶寬 = k × σ（stdDev，EWMA 平滑）\n` +
            `震盪市（Low Vol）: k_low；趨勢市（High Vol）: k_high\n` +
            `用 /bbk 調整，目前 k=${appState.marketKLowVol}/${appState.marketKHighVol}\n\n` +
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

    bot.command('dex', (ctx) => {
        const list = config.VALID_DEXES.map(d => `  · <code>${d}</code>`).join('\n');
        ctx.reply(`🔀 <b>支援的 DEX</b>\n\n${list}`, { parse_mode: 'HTML' });
    });
}
