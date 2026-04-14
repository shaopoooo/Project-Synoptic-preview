/** 驗證 0x 格式的錢包地址（40 hex chars） */
export const WALLET_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** 驗證 V3 pool 合約地址（40 hex chars，與錢包地址格式相同） */
export const POOL_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** 驗證 V4 poolId（bytes32，64 hex chars） */
export const POOL_V4_ID_RE = /^0x[0-9a-fA-F]{64}$/;

export function isValidWalletAddress(address: string): boolean {
    return WALLET_ADDRESS_RE.test(address);
}

export function isValidPoolAddress(address: string): boolean {
    return POOL_ADDRESS_RE.test(address);
}

export function isValidPoolV4Id(poolId: string): boolean {
    return POOL_V4_ID_RE.test(poolId);
}
