import { Bot } from 'grammy';
import { config } from '../config';
import { PoolStats, MarketSnapshot, PositionRecord, RiskAnalysis, UserConfig } from '../types';
import { createServiceLogger } from '../infra/logger';
import type { PositionScanner } from '../market/position/PositionScanner';
import { BotDeps } from './commands/context';
import { registerInfoCommands } from './commands/infoCommands';
import { registerConfigCommands } from './commands/configCommands';
import { registerWalletCommands } from './commands/walletCommands';
import { registerPoolCommands } from './commands/poolCommands';
import { registerPositionCommands } from './commands/positionCommands';
import { registerCalcCommands } from './commands/calcCommands';
import { sendConsolidatedReport as buildAndSendReport, sendFlashReport as buildAndSendFlash } from './reportService';
import { registerDiagnosticCommands } from './commands/diagnosticCommands';
import { registerRegimeCommands } from './commands/regimeCommands';

const log = createServiceLogger('TelegramBot');

// Re-exports for backward compatibility
export { VALID_INTERVALS, minutesToCron } from './commands/context';
export type { IntervalMinutes } from './commands/context';

export class TelegramBotService {
    private bot: Bot;
    private chatId: string;
    private deps: BotDeps = {
        onReschedule: null,
        onUserConfigChange: null,
        positionScanner: null,
    };

    setPositionScanner(scanner: PositionScanner) {
        this.deps.positionScanner = scanner;
    }

    setRescheduleCallback(cb: (minutes: number) => void) {
        this.deps.onReschedule = cb;
    }

    /** 設定 userConfig 變更時的回呼（更新 appState 並持久化）。 */
    setUserConfigChangeCallback(cb: (cfg: UserConfig) => Promise<void>) {
        this.deps.onUserConfigChange = cb;
    }

    constructor() {
        this.bot = new Bot(config.BOT_TOKEN);
        this.chatId = config.CHAT_ID;

        // 授權中間件：只允許指定 CHAT_ID 的訊息通過
        this.bot.use(async (ctx, next) => {
            if (String(ctx.chat?.id) !== this.chatId) return;
            await next();
        });

        registerInfoCommands(this.bot);
        registerConfigCommands(this.bot, this.deps);
        registerWalletCommands(this.bot, this.deps);
        registerPoolCommands(this.bot, this.deps);
        registerPositionCommands(this.bot, this.deps);
        registerCalcCommands(this.bot);
        registerRegimeCommands(this.bot);
    }

    registerDiagnostics(diagnosticStore: import('../infra/diagnosticStore').DiagnosticStore) {
        registerDiagnosticCommands(this.bot, diagnosticStore);
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

    /** 推播輕量快訊（幣價 + 總覽 + 異常倉位） */
    public async sendFlashReport(positions: PositionRecord[]) {
        await buildAndSendFlash(this.sendAlert.bind(this), positions);
    }

    /** 將所有倉位合併為單一 Telegram 報告 */
    public async sendConsolidatedReport(
        entries: Array<{ position: PositionRecord; pool: PoolStats; bb: MarketSnapshot | null; risk: RiskAnalysis }>,
        allPools: PoolStats[],
        lastUpdates: { cycleAt: number }
    ) {
        await buildAndSendReport(this.sendAlert.bind(this), entries, allPools, lastUpdates);
    }
}
