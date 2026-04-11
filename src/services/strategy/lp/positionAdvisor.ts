/**
 * PositionAdvisor — 部位建議純函數集
 *
 * 提供三個無副作用的決策函數：
 *   - recommendOpen：根據 MC 最佳策略決定是否建議開倉
 *   - classifyExit：部位穿出 core band 後決定 hold 或 rebalance
 *   - shouldClose：判斷是否該完全關倉（多個觸發條件按優先序裁決）
 *
 * 所有閾值皆為「經驗值，待 backtest 驗證」，PR 4 將以歷史數據調參。
 *
 * 設計原則：
 *   - Phase 1 純計算：無 RPC、無 fs、無 await
 *   - 唯一外部狀態：shouldClose 內 Date.now() 用於 timeout 比較（單次讀取）
 *   - TypeScript strict、禁止 any
 */

import type { OpeningStrategy, RegimeVector, PositionRecord, MCSimResult } from '../../../types';
import type {
  OpenAdvice,
  ExitAdvice,
  CloseAdvice,
  ExitDecision,
  CloseReason,
} from '../../../types/positionAdvice';

// ─── 閾值常數（經驗值，待 backtest 驗證） ───────────────────────────────────

/** Sharpe score 門檻：< 0.5（含灰色帶 0.3–0.5 與下限 0.3）一律不建議開倉 */
const SHARPE_MIN_SCORE = 0.5;

/** 穿出深度上限：|depth| ≤ 2×ATR 才考慮 hold，超過直接 rebalance */
const ATR_DEPTH_HOLD_MAX = 2;

/** regime.range 下限：≥ 0.5 才允許 hold（震盪市場才有回歸機率） */
const REGIME_RANGE_HOLD_MIN = 0.5;

/** 預設 gas 成本（Base chain 單次 rebalance 約 $0.5） */
const DEFAULT_GAS_COST_USD = 0.5;

/** trend 權重門檻：> 0.6 視為強趨勢，觸發 trend_shift 關倉 */
const REGIME_TREND_CLOSE = 0.6;

/** MC score 門檻：< 0.3 視為預期報酬不佳，觸發 opportunity_lost */
const MC_SCORE_OPPORTUNITY_LOST = 0.3;

/** 累計 IL 門檻：> 5% 觸發 il_threshold 關倉 */
const IL_THRESHOLD_PCT = 0.05;

/** out-of-range 容忍時間：> 4 小時未回歸觸發 timeout */
const OUT_OF_RANGE_TIMEOUT_MS = 4 * 60 * 60 * 1000;

// ─── 內部 helper ──────────────────────────────────────────────────────────

/**
 * 計算穿出深度（以 ATR 半寬為單位）。
 *
 * 公式推導（在正規化空間下，價格 / ATR 均已正規化）：
 *   - 若 price 在 [Pa, Pb] 內：depth = 0（呼叫端應已過濾）
 *   - 若 price < Pa（下方穿出）：depth = (Pa - price) / atrHalfWidth
 *   - 若 price > Pb（上方穿出）：depth = (price - Pb) / atrHalfWidth
 *   - 若 atrHalfWidth === 0：回傳 Infinity 以強制 rebalance，避免除 0
 *
 * 對稱性：上下穿出用相同 |price - 邊界| 規則，保證 hold / rebalance 判斷對稱。
 */
function computePenetration(
  priceNorm: number,
  PaNorm: number,
  PbNorm: number,
  atrHalfWidth: number,
): number {
  if (atrHalfWidth === 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (priceNorm < PaNorm) {
    return (PaNorm - priceNorm) / atrHalfWidth;
  }
  // priceNorm > PbNorm（呼叫端已排除 in-range 情況）
  return (priceNorm - PbNorm) / atrHalfWidth;
}

/** 產生顯示用 poolLabel：dex 名稱 + 縮寫地址。 */
function formatPoolLabel(position: PositionRecord): string {
  return `${position.dex} ${position.poolAddress.slice(0, 6)}...`;
}

// ─── recommendOpen ────────────────────────────────────────────────────────

/**
 * 判斷是否建議開倉。
 *
 * 決策規則：
 *   1. strategy === null → 無 MC 結果，返回 null
 *   2. strategy.computedAt === 0 → MC 未跑過，返回 null
 *   3. strategy.score < 0.5 → Sharpe 不足（覆蓋灰色帶 0.3–0.5 與下限 0.3），返回 null
 *   4. 否則產出 OpenAdvice
 *
 * rangeWidthPct 公式（core band 在正規化空間下的寬度，相對中心價百分比）：
 *   width% = (upper - lower) / ((upper + lower) / 2) × 100
 *
 * 注意：regime gating（例如 trend regime 時不開倉）由呼叫端處理，本函數只看數字。
 */
export function recommendOpen(
  strategy: OpeningStrategy | null,
  regimeVector: RegimeVector,
  poolLabel: string,
): OpenAdvice | null {
  if (strategy === null) return null;
  if (strategy.computedAt === 0) return null;
  if (strategy.score < SHARPE_MIN_SCORE) return null;

  const { lower, upper } = strategy.coreBand;
  const center = (lower + upper) / 2;
  const rangeWidthPct = center === 0 ? 0 : ((upper - lower) / center) * 100;

  return {
    poolId: strategy.poolAddress,
    poolLabel,
    ratio: `core [${lower}, ${upper}]`,
    rangeWidthPct,
    score: strategy.score,
    expectedReturnPct: strategy.mean * 100,
    cvar95Pct: strategy.cvar95 * 100,
    regimeVector,
  };
}

// ─── classifyExit ─────────────────────────────────────────────────────────

/**
 * 分類穿出部位的處置方式（hold vs rebalance）。
 *
 * 流程：
 *   1. price 在 [Pa, Pb] 內 → 返回 null（未穿出，呼叫端不需處置）
 *   2. 計算穿出深度 depth（見 computePenetration）
 *   3. hold 條件：depth ≤ 2×ATR 且 regime.range ≥ 0.5
 *      - 深度淺：回歸機率高，IL 小，硬扛成本 < rebalance gas
 *      - 震盪市場：方向未定，等回歸期望值 > 新開倉
 *   4. 否則 rebalance：深度超過 2×ATR 或市場轉趨勢，重新開倉成本合理
 *
 * 經驗值來源：Base chain gas ~$0.5，2×ATR 對應 ~2σ 事件，實測比 1×ATR 穩定，
 * PR 4 backtest 會以歷史 L→R 回歸率調參。
 */
export function classifyExit(
  position: PositionRecord,
  currentPriceNorm: number,
  PaNorm: number,
  PbNorm: number,
  atrHalfWidth: number,
  regimeVector: RegimeVector,
): ExitAdvice | null {
  if (currentPriceNorm >= PaNorm && currentPriceNorm <= PbNorm) {
    return null;
  }

  const penetrationDepthAtr = computePenetration(
    currentPriceNorm,
    PaNorm,
    PbNorm,
    atrHalfWidth,
  );

  const canHold =
    penetrationDepthAtr <= ATR_DEPTH_HOLD_MAX &&
    regimeVector.range >= REGIME_RANGE_HOLD_MIN;
  const decision: ExitDecision = canHold ? 'hold' : 'rebalance';

  return {
    positionId: position.tokenId,
    poolLabel: formatPoolLabel(position),
    decision,
    penetrationDepthAtr,
    // TODO(PR4): 精確化 IL 估算，現階段 0 滿足 type，無 test 要求
    ilEstimatePct: 0,
    gasCostUsd: DEFAULT_GAS_COST_USD,
  };
}

// ─── shouldClose ──────────────────────────────────────────────────────────

/**
 * 判斷是否該完全關倉。
 *
 * 嚴格優先序（第一個匹配即返回，後續條件忽略）：
 *   1. trend_shift      — regime.trend > 0.6（市場轉強趨勢，LP 部位逆風）
 *   2. il_threshold     — cumulativeIlPct > 0.05（實虧已超過合理容忍）
 *   3. opportunity_lost — mc.score < 0.3（MC 重算後預期報酬不佳）
 *   4. timeout          — out-of-range > 4h（長期未回歸，機會成本累積）
 *
 * 優先序設計理由：
 *   - trend 最優先：方向判斷最直接，錯過會持續虧損
 *   - il 次之：已實虧的退場信號比預期信號可靠
 *   - opportunity_lost 第三：預期信號，容忍度較高
 *   - timeout 最後：時間信號最軟，只在其他條件都沒觸發時兜底
 *
 * Null sentinel 語義：
 *   - cumulativeIlPct === null → 跳過 il 檢查（不觸發也不阻擋其他 reason）
 *   - outOfRangeSinceMs === null → 跳過 timeout 檢查
 *
 * Date.now() 使用說明：本函數為 Phase 1 純計算，但 timeout 比較需要「當下時間」。
 * 單次讀取 Date.now() 屬可接受的非純性（決定性：輸入 + 當下時間），不引入 clock
 * 注入以免測試複雜化（測試自行用 Date.now() - Nh 構造 fixture 即可）。
 */
export function shouldClose(
  position: PositionRecord,
  mc: MCSimResult,
  regimeVector: RegimeVector,
  outOfRangeSinceMs: number | null,
  cumulativeIlPct: number | null,
): CloseAdvice | null {
  let reason: CloseReason | null = null;

  if (regimeVector.trend > REGIME_TREND_CLOSE) {
    reason = 'trend_shift';
  } else if (cumulativeIlPct !== null && cumulativeIlPct > IL_THRESHOLD_PCT) {
    reason = 'il_threshold';
  } else if (mc.score < MC_SCORE_OPPORTUNITY_LOST) {
    reason = 'opportunity_lost';
  } else if (
    outOfRangeSinceMs !== null &&
    Date.now() - outOfRangeSinceMs > OUT_OF_RANGE_TIMEOUT_MS
  ) {
    reason = 'timeout';
  }

  if (reason === null) return null;

  return {
    positionId: position.tokenId,
    poolLabel: formatPoolLabel(position),
    reason,
    // TODO(PR4): 由 PnlCalculator 提供真實累計 PnL
    cumulativePnlPct: 0,
  };
}
