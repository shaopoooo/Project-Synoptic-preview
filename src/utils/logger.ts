import winston from 'winston';
import path from 'path';
import util from 'util';
import { env } from '../config/env';

const logDir = path.join(__dirname, '../../logs');

// 從環境變數讀取 Log 級別，預設 Console 顯示 info，File 儲存 debug
const CONSOLE_LOG_LEVEL = env.LOG_LEVEL;
const FILE_LOG_LEVEL = env.FILE_LOG_LEVEL;

// 定義系統分級
const CUSTOM_LEVELS = {
    fatal: 0, // 系統級別崩潰、資料庫斷連、關鍵資料歸零
    error: 1, // 可恢復的異常、單一 API 掛掉
    warn: 2, // 預期內的例外、Rate limit、參數異常
    info: 3, // 重要的業務流程、生命週期
    debug: 4, // 開發與追蹤用的詳細資訊
    trace: 5, // 海量參數傾印
};

// ANSI 色碼
const SERVICE_COLORS: Record<string, string> = {
    'Main': '\x1b[97m',  // White
    'PoolScanner': '\x1b[36m',  // Cyan
    'PoolMarketService': '\x1b[35m',  // Magenta
    'PositionScanner': '\x1b[34m',  // Blue
    'RiskManager': '\x1b[33m',  // Yellow
    'TelegramBot': '\x1b[32m',  // Green
    'RPC': '\x1b[90m',  // Grey
    'Prefetch': '\x1b[38;5;208m', // Orange
    'TokenPrices': '\x1b[38;5;117m', // Light Blue
};

const LEVEL_COLORS: Record<string, string> = {
    'FATAL': '\x1b[41m\x1b[37m\x1b[1m', // Red Background, White Text, Bold
    'ERROR': '\x1b[31m\x1b[1m',          // Red Bold
    'WARN': '\x1b[33m',                // Yellow
    'INFO': '\x1b[32m',                // Green
    'DEBUG': '\x1b[36m',                // Cyan
    'TRACE': '\x1b[90m',                // Grey
};

const LEVEL_ICONS: Record<string, string> = {
    'FATAL': '🔥 ',
    'ERROR': '✖ ',
    'WARN': '⚠ ',
    'INFO': '· ',
    'DEBUG': '⚙ ',
    'TRACE': '🔍 ',
};

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

// 將 Service Name 補齊到固定長度，讓所有日誌對齊
const padService = (svc: string) => svc.padEnd(14, ' ');

// 提供給檔案用的純文字格式 (支援參數與錯誤)
const fileFormat = winston.format.printf((info) => {
    // 扣除基礎屬性，剩下的視為附帶參數 (meta)
    const { level, message, timestamp, service, stack, dev, ...meta } = info;
    const metaStr = Object.keys(meta).length ? ` | Params: ${JSON.stringify(meta)}` : '';
    const stackStr = stack ? `\n${stack}` : '';
    const prefix = dev ? '[DEV] ' : '';
    return `${timestamp} [${padService((service as string) || 'App')}] ${level.toUpperCase().padEnd(5)}: ${prefix}${message}${metaStr}${stackStr}`;
});

// 提供給終端機用的顯色格式 (支援物件展開與自訂顏色)
const consoleFormat = winston.format.printf((info) => {
    const { level, message, timestamp, service, stack, dev, ...meta } = info;
    const svc = padService((service as string) || 'App');
    const lvlUp = level.toUpperCase();

    // 取得顏色
    const svcClr = SERVICE_COLORS[service as string] ?? '\x1b[37m';
    const lvlClr = LEVEL_COLORS[lvlUp] ?? '\x1b[37m';
    const icon = LEVEL_ICONS[lvlUp] ?? '· ';

    const ts = `${DIM}${timestamp}${RESET}`;
    const tag = `${BOLD}${svcClr}[${svc.trim()}]${RESET}`;
    // 保持 Terminal 的對齊
    const tagPadded = tag + ' '.repeat(Math.max(0, 14 - svc.trim().length));
    const lv = `${lvlClr}${icon}${lvlUp.padEnd(5)}${RESET}`;

    let msgColor = svcClr;
    if (lvlUp === 'FATAL' || lvlUp === 'ERROR') msgColor = `${BOLD}${lvlClr}`;
    else if (lvlUp === 'WARN') msgColor = lvlClr;
    else if (lvlUp === 'DEBUG' || lvlUp === 'TRACE') msgColor = DIM;

    const prefix = dev ? '[DEV] ' : '';
    const formattedMsg = `${msgColor}${prefix}${message}${RESET}`;

    // 將額外的參數物件 (meta) 漂亮的打印出來
    const metaStr = Object.keys(meta).length
        ? `\n${util.inspect(meta, { colors: true, depth: 3, breakLength: 80 })}`
        : '';

    // 終端機只印出縮減版的 Stack Trace，避免洗版
    const stackStr = typeof stack === 'string'
        ? `\n${DIM}${stack.split('\n').slice(0, 3).join('\n')}${RESET}`
        : '';

    return `${ts} ${tagPadded} │ ${lv} │ ${formattedMsg}${metaStr}${stackStr}`;
});

// 重寫 Winston Logger
const logger = winston.createLogger({
    levels: CUSTOM_LEVELS,
    level: 'trace', // 基底層放寬至 trace，由各 Transports 自己過濾
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }), // 擷取 Error 物件的 call stack
        winston.format.splat()                  // 支援字串插值 (String interpolation)
    ),
    defaultMeta: { service: 'DexInfoBot' },
    transports: [
        new winston.transports.Console({
            level: CONSOLE_LOG_LEVEL, // 隨終端機環境變數動態切換
            format: winston.format.combine(
                winston.format.timestamp({ format: 'HH:mm:ss' }),
                consoleFormat
            )
        }),
        new winston.transports.File({
            filename: path.join(logDir, 'combined.log'),
            level: FILE_LOG_LEVEL, // 檔案預設儲存 debug
            maxsize: 10 * 1024 * 1024,
            maxFiles: 7,
            format: fileFormat
        }),
        new winston.transports.File({
            filename: path.join(logDir, 'error.log'),
            level: 'error', // 只記錄 fatal 和 error
            maxsize: 5 * 1024 * 1024,
            maxFiles: 3,
            format: fileFormat
        })
    ]
});

/**
 * 專門給 Snapshot (倉位歷史) 的唯讀 append-log
 */
export const positionLogger = winston.createLogger({
    level: 'info',
    format: winston.format.printf(({ message }) => String(message)),
    transports: [
        new winston.transports.File({
            filename: path.join(logDir, 'positions.log'),
            maxsize: 10 * 1024 * 1024,
            maxFiles: 10
        })
    ]
});

// 定義子 Logger 的型別，包含自訂等級與擴展方法
export interface ServiceLogger extends winston.Logger {
    fatal: winston.LeveledLogMethod;
    trace: winston.LeveledLogMethod;
    section: (title: string) => void;
    dev: (msg: string, ...meta: any[]) => void;
}

/**
 * 建立獨立的子服務 Logger，繼承自訂 Level 系統並附加快捷鍵
 */
export function createServiceLogger(serviceName: string): ServiceLogger {
    const child = logger.child({ service: serviceName }) as ServiceLogger;

    return Object.assign(child, {
        section: (title: string) => {
            const line = '─'.repeat(Math.max(0, 50 - title.length));
            // 用 info 級別印出強視覺區塊
            child.info(`\x1b[1m\x1b[36m${line} ${title} ${line}\x1b[0m`);
        },
        dev: (msg: string, ...meta: any[]) => child.debug(msg, { dev: true, ...meta }),
    });
}

/**
 * 用於記錄結構化計算參數的快捷函數，對應最新 6 級制中的 TRACE/DEBUG。
 */
export function logCalc(data: Record<string, any>) {
    (logger as any).trace('Calc Data: %o', data);
}

export default logger;
