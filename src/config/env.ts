import * as dotenv from 'dotenv';
dotenv.config();

export const env = {
    RPC_URL: process.env.RPC_URL || 'https://mainnet.base.org',
    WALLET_ADDRESS: process.env.WALLET_ADDRESS || '',
    SUBGRAPH_API_KEY: process.env.SUBGRAPH_API_KEY || '',
    BOT_TOKEN: process.env.BOT_TOKEN || '',
    CHAT_ID: process.env.CHAT_ID || '',
};
