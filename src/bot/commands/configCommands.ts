import type { Bot } from 'grammy';
import { config } from '../../config';
import { appState } from '../../utils/AppState';
import { fmtInterval } from '../../utils/formatter';
import { VALID_INTERVALS, minutesToCron, type BotDeps, type IntervalMinutes } from './context';

/** 驗證快訊 / 完整報告間隔輸入。回傳錯誤說明字串，合法則回傳 null。 */
function validateReportInterval(minutes: number, type: 'flash' | 'full'): string | null {
    if (!Number.isInteger(minutes) || minutes <= 0) return '❌ 間隔須為正整數';
    if (minutes % 10 !== 0) return '❌ 間隔須為 10 的倍數';
    const scanMinutes = appState.userConfig.intervalMinutes ?? config.DEFAULT_INTERVAL_MINUTES;
    if (type === 'flash') {
        if (minutes < scanMinutes) return `❌ 快訊間隔須 ≥ 掃描間隔（目前 ${scanMinutes} 分鐘）`;
    } else {
        const flashMinutes = appState.userConfig.flashIntervalMinutes ?? config.DEFAULT_FLASH_INTERVAL_MINUTES;
        if (minutes < flashMinutes) return `❌ 完整報告間隔須 ≥ 快訊間隔（目前 ${flashMinutes} 分鐘）`;
    }
    return null;
}

export function registerConfigCommands(bot: Bot, deps: BotDeps): void {
    bot.command('sort', async (ctx) => {
        const key = (ctx.match?.trim() ?? '') as keyof typeof config.SORT_LABELS;
        const valid = Object.keys(config.SORT_LABELS) as (keyof typeof config.SORT_LABELS)[];
        if (valid.includes(key)) {
            const newCfg = { ...appState.userConfig, sortBy: key };
            if (deps.onUserConfigChange) await deps.onUserConfigChange(newCfg);
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

    bot.command('interval', async (ctx) => {
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
        if (deps.onReschedule) {
            deps.onReschedule(min);
            const newCfg = { ...appState.userConfig, intervalMinutes: min };
            if (deps.onUserConfigChange) await deps.onUserConfigChange(newCfg);
            ctx.reply(`✅ 排程已更新為每 <b>${fmtInterval(min)}</b> 執行一次\n（cron: <code>${minutesToCron(min)}</code>）`, { parse_mode: 'HTML' });
        } else {
            ctx.reply('❌ 排程功能尚未初始化');
        }
    });

    bot.command('bbk', async (ctx) => {
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
        if (deps.onUserConfigChange) await deps.onUserConfigChange(newCfg);
        ctx.reply(
            `✅ BB k 值已更新\nk_low=<b>${kLow}</b>  k_high=<b>${kHigh}</b>\n（下個週期生效）`,
            { parse_mode: 'HTML' }
        );
    });

    bot.command('report', async (ctx) => {
        const parts = (ctx.match?.trim() ?? '').split(/\s+/).filter(Boolean);

        if (parts.length === 0) {
            // 顯示目前設定
            const scan = appState.userConfig.intervalMinutes ?? config.DEFAULT_INTERVAL_MINUTES;
            const flash = appState.userConfig.flashIntervalMinutes ?? config.DEFAULT_FLASH_INTERVAL_MINUTES;
            const report = appState.userConfig.fullReportIntervalMinutes ?? config.DEFAULT_FULL_REPORT_INTERVAL_MINUTES;
            ctx.reply(
                `📋 <b>報告排程設定</b>\n\n` +
                `掃描間隔　　: <code>${fmtInterval(scan)}</code>（/interval 修改）\n` +
                `快訊間隔　　: <code>${fmtInterval(flash)}</code>（/report flash &lt;分鐘&gt;）\n` +
                `完整報告間隔: <code>${fmtInterval(report)}</code>（/report full &lt;分鐘&gt;）\n\n` +
                `驗證規則: 掃描 ≤ 快訊 ≤ 完整報告，均須為 10 的倍數`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        const subCmd = parts[0].toLowerCase();
        if (subCmd !== 'flash' && subCmd !== 'full') {
            ctx.reply('❌ 用法: /report flash &lt;分鐘&gt; 或 /report full &lt;分鐘&gt;', { parse_mode: 'HTML' });
            return;
        }

        const minutes = parseInt(parts[1] ?? '', 10);
        if (isNaN(minutes)) {
            ctx.reply(`❌ 請提供分鐘數，例如: /report ${subCmd} ${subCmd === 'flash' ? '60' : '1440'}`, { parse_mode: 'HTML' });
            return;
        }

        const err = validateReportInterval(minutes, subCmd as 'flash' | 'full');
        if (err) { ctx.reply(err); return; }

        const field = subCmd === 'flash' ? 'flashIntervalMinutes' : 'fullReportIntervalMinutes';
        const newCfg = { ...appState.userConfig, [field]: minutes };
        if (deps.onUserConfigChange) await deps.onUserConfigChange(newCfg);
        const label = subCmd === 'flash' ? '快訊' : '完整報告';
        ctx.reply(`✅ ${label}間隔已設為 <b>${fmtInterval(minutes)}</b>（下個週期生效）`, { parse_mode: 'HTML' });
    });
}
