import type { RegimeVector } from './index';

/** 開倉建議（由 PositionAdvisor.recommendOpen 產出） */
export interface OpenAdvice {
  /** 池合約地址（唯一識別） */
  poolId: string;
  /** 顯示用標籤：dex 名稱 + 縮寫地址，e.g. "UniswapV3 0xpool..." */
  poolLabel: string;
  /** core band 簡短描述，Telegram 層會再格式化 */
  ratio: string;
  /** core band 寬度（相對於中心價，%） */
  rangeWidthPct: number;
  /** Sharpe-like 風險調整報酬 = strategy.score */
  score: number;
  /** 預期報酬（%）= strategy.mean × 100，相對 HODL 基準 */
  expectedReturnPct: number;
  /** 95% 條件風險值（%）= strategy.cvar95 × 100，負值代表虧損 */
  cvar95Pct: number;
  /** 當前市場 regime 向量，供下游判斷 / 顯示 */
  regimeVector: RegimeVector;
}

/** 穿出後的決策：維持部位 (hold) 或重新開倉 (rebalance) */
export type ExitDecision = 'hold' | 'rebalance';

/** 穿出建議（由 PositionAdvisor.classifyExit 產出） */
export interface ExitAdvice {
  /** Uniswap V3 NFT tokenId */
  positionId: string;
  /** 顯示用標籤：dex 名稱 + 縮寫地址 */
  poolLabel: string;
  /** 決策：hold 或 rebalance */
  decision: ExitDecision;
  /** 穿出深度（以 ATR 半寬為單位，>0 表穿出幾倍 ATR） */
  penetrationDepthAtr: number;
  /** 若重新開倉的 IL 估算（%），Task 9 暫填 0，後續由 backtest 精確化 */
  ilEstimatePct: number;
  /** 重新開倉的 gas 成本估算（USD），Base 約 $0.5 */
  gasCostUsd: number;
}

/** 關倉原因，優先序：trend > il > opportunity_lost > timeout */
export type CloseReason = 'trend_shift' | 'il_threshold' | 'opportunity_lost' | 'timeout';

/** 關倉建議（由 PositionAdvisor.shouldClose 產出） */
export interface CloseAdvice {
  /** Uniswap V3 NFT tokenId */
  positionId: string;
  /** 顯示用標籤：dex 名稱 + 縮寫地址 */
  poolLabel: string;
  /** 觸發的關倉原因（嚴格優先序下的第一個匹配） */
  reason: CloseReason;
  /** 累計 PnL（%），Task 9 暫填 0，後續由 PnlCalculator 提供 */
  cumulativePnlPct: number;
}
