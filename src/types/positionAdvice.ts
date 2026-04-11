import type { RegimeVector } from './index';

/** 開倉建議 */
export interface OpenAdvice {
  poolId: string;
  poolLabel: string;          // dex 名稱 + 縮寫地址
  ratio: string;              // e.g. "目前 0.0307"
  rangeWidthPct: number;      // ±X%
  score: number;              // Sharpe-like, = strategy.score
  expectedReturnPct: number;  // = strategy.mean × 100（相對 HODL 基準）
  cvar95Pct: number;          // = strategy.cvar95 × 100
  regimeVector: RegimeVector;
}

/** 穿出後的決策 */
export type ExitDecision = 'hold' | 'rebalance';

export interface ExitAdvice {
  positionId: string;
  poolLabel: string;
  decision: ExitDecision;
  penetrationDepthAtr: number;  // 穿出幾個 ATR
  ilEstimatePct: number;        // 重開倉 IL 估算（%）
  gasCostUsd: number;           // ~$0.5 on Base
}

/** 關倉原因（優先序：trend > il > opportunity_lost > timeout） */
export type CloseReason = 'trend_shift' | 'il_threshold' | 'opportunity_lost' | 'timeout';

export interface CloseAdvice {
  positionId: string;
  poolLabel: string;
  reason: CloseReason;
  cumulativePnlPct: number;
}
