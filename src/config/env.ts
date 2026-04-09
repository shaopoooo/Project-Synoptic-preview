export const env = {
    RPC_URL: process.env.RPC_URL || 'https://mainnet.base.org',
    WALLET_ADDRESSES: (() => {
        const wallets: string[] = [];
        let i = 1;
        while (process.env[`WALLET_ADDRESS_${i}`]) {
            wallets.push(process.env[`WALLET_ADDRESS_${i}`]!.trim());
            i++;
        }
        return wallets;
    })(),
    SUBGRAPH_API_KEY: process.env.SUBGRAPH_API_KEY || '',
    BOT_TOKEN: process.env.BOT_TOKEN || '',
    CHAT_ID: process.env.CHAT_ID || '',
    FAST_STARTUP: process.env.FAST_STARTUP === 'true',
    PANCAKE_MASTERCHEF_V3: process.env.PANCAKE_MASTERCHEF_V3 || '0xC6A2Db661D5a5690172d8eB0a7DEA2d3008665A3',
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    FILE_LOG_LEVEL: process.env.FILE_LOG_LEVEL || 'debug',
    COINGECKO_API_KEY: process.env.COINGECKO_API_KEY || '',
    REGIME_DIAGNOSTIC: process.env.REGIME_DIAGNOSTIC === 'true',
};

/** 驗證必填環境變數，缺少時輸出錯誤並中止程式。
 *  WALLET_ADDRESS_1 已可透過 Telegram /wallet add 動態新增並存入 state.json，
 *  因此不強制要求（main() 在 state 載入後會做二次驗證）。
 */
export function validateEnv(): void {
    const missing: string[] = [];
    if (!process.env.BOT_TOKEN) missing.push('BOT_TOKEN');
    if (!process.env.CHAT_ID) missing.push('CHAT_ID');
    if (missing.length > 0) {
        console.error(`[env] 缺少必填環境變數: ${missing.join(', ')}\n請確認 .env 檔案或部署環境的環境變數設定。`);
        process.exit(1);
    }
}
