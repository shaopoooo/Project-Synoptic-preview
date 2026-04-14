/**
 * V3LpReplayDriver — V3 LP replay 驅動器（Stage 1 / Group D / Batch 4）
 *
 * 遍歷 ReplayFeature[] 序列，以 Map 維護 hypothetical positions，
 * 呼叫 PositionAdvisor 純函數 recommendOpen 判斷開倉，
 * 自行實作 classifyExit（使用 threshold.atrMultiplier 取代 hardcoded ATR_DEPTH_HOLD_MAX）
 * 與 close 邏輯（避免 shouldClose 的 Date.now() 在 backtest 不適用問題）。
 *
 * 兩種模式：
 * - `'raw'`：無 hysteresis，score 過門檻即觸發（粗掃 grid search 用）
 * - `'full-state'`：2-cycle 連續門檻才觸發（精調 grid search 用）
 *
 * ## shouldClose / Date.now() 偏離說明
 *
 * PositionAdvisor.shouldClose 內部使用 `Date.now() - outOfRangeSinceMs` 判斷 timeout，
 * 但在 backtest context 中 Date.now() 是真實牆鐘而非 replay 時間戳，會導致 timeout
 * 判斷錯誤。因此 driver 自行以 replay 時間軸實作 4 個 close 條件的優先序檢查，
 * 不呼叫 shouldClose。recommendOpen 與 classifyExit 無此問題，正常呼叫。
 *
 * @module
 */

import type {
    ReplayFeature,
    HypotheticalPosition,
    PositionOutcome,
    ThresholdSet,
} from '../../types/replay';
import type {
    OpeningStrategy,
    RegimeVector,
} from '../../types';
import type { CloseReason, ExitDecision } from '../../types/positionAdvice';
import { recommendOpen } from '../../engine/lp/positionAdvisor';
import { computeOutcome } from './outcomeCalculator';
import { INITIAL_CAPITAL } from '../config';

// ─── 常數 ─────────────────────────────────────────────────────────────────

/** trend 權重門檻：> 0.6 視為強趨勢，觸發 trend_shift 關倉（對齊 positionAdvisor） */
const REGIME_TREND_CLOSE = 0.6;

/** MC score 門檻：< 0.3 視為預期報酬不佳（對齊 positionAdvisor） */
const MC_SCORE_OPPORTUNITY_LOST = 0.3;

/** 累計 IL 門檻：> 5%（對齊 positionAdvisor） */
const IL_THRESHOLD_PCT = 0.05;

/** out-of-range 容忍時間：4 小時（ms）（對齊 positionAdvisor） */
const OUT_OF_RANGE_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** regime.range 下限：≥ 0.5 才允許 hold（對齊 positionAdvisor REGIME_RANGE_HOLD_MIN） */
const REGIME_RANGE_HOLD_MIN = 0.5;

/** 7 天 hard cap（cycle 數 = 168 hours） */
const HARD_CAP_CYCLES = 168;

/** Rebalance gas 成本（USD）（對齊 positionAdvisor DEFAULT_GAS_COST_USD） */
const REBALANCE_GAS_USD = 0.5;

// ─── 合成 helpers ─────────────────────────────────────────────────────────

/**
 * 從 ReplayFeature 合成 OpeningStrategy（供 recommendOpen 使用）。
 *
 * 僅填入 recommendOpen 實際讀取的欄位（score, mean, cvar95, std, coreBand, computedAt,
 * poolAddress）。其餘欄位（sigmaOpt, bufferBand, trancheCore, trancheBuffer）填
 * 合理預設值，recommendOpen 不使用它們。
 *
 * @returns null 表示該 cycle 資料不足（mc 或 range 欄位為 null）
 */
function featureToStrategy(f: ReplayFeature): OpeningStrategy | null {
    if (
        f.mcScore === null || f.mcMean === null ||
        f.mcStd === null || f.mcCvar95 === null
    ) return null;
    if (f.PaNorm === null || f.PbNorm === null) return null;

    return {
        poolAddress: f.poolId,
        sigmaOpt: 0,
        score: f.mcScore,
        cvar95: f.mcCvar95,
        mean: f.mcMean,
        std: f.mcStd,
        coreBand: { lower: f.PaNorm, upper: f.PbNorm },
        bufferBand: { lower: f.PaNorm * 0.9, upper: f.PbNorm * 1.1 },
        trancheCore: 0.7,
        trancheBuffer: 0.3,
        computedAt: f.ts,
    };
}

// ─── Exit 邏輯（inline classifyExit，使用 threshold.atrMultiplier）────────

/**
 * 判斷穿出倉位的 hold vs rebalance（inline 版，取代 positionAdvisor.classifyExit）。
 *
 * 原因：positionAdvisor.classifyExit 使用 hardcoded `ATR_DEPTH_HOLD_MAX = 2`，
 * 但 grid search 需要以 `threshold.atrMultiplier` 參數化此閾值。若直接呼叫
 * classifyExit，atrMultiplier 維度的 sweep 完全無效（所有 ATR 值產生相同結果）。
 *
 * 公式（與 positionAdvisor.classifyExit 等價，差別在 depth 閾值來源）：
 *   - 穿出深度 depth = |price - nearestBound| / atrHalfWidth
 *   - hold 條件：depth ≤ threshold.atrMultiplier AND regime.range ≥ 0.5
 *   - 否則 rebalance
 *   - atrHalfWidth === 0 → 強制 rebalance（避免除零）
 */
function evaluateExit(
    currentPriceNorm: number,
    PaNorm: number,
    PbNorm: number,
    atrHalfWidth: number,
    regime: RegimeVector,
    atrMultiplier: number,
): ExitDecision | null {
    // 在 range 內 → 無需處置
    if (currentPriceNorm >= PaNorm && currentPriceNorm <= PbNorm) return null;

    // 計算穿出深度
    let depth: number;
    if (atrHalfWidth === 0) {
        depth = Number.POSITIVE_INFINITY;
    } else if (currentPriceNorm < PaNorm) {
        depth = (PaNorm - currentPriceNorm) / atrHalfWidth;
    } else {
        depth = (currentPriceNorm - PbNorm) / atrHalfWidth;
    }

    // hold 條件：深度淺 + 震盪市場
    if (depth <= atrMultiplier && regime.range >= REGIME_RANGE_HOLD_MIN) {
        return 'hold';
    }
    return 'rebalance';
}

// ─── Close 邏輯（自行實作，避免 shouldClose 的 Date.now() 問題）──────────

/**
 * 以 replay 時間軸評估 4 個 close 條件（優先序：trend > il > opportunity_lost > timeout）。
 *
 * 與 positionAdvisor.shouldClose 邏輯等價，差別在於 timeout 用 replay 時間計算
 * 而非 Date.now()。
 */
function evaluateClose(
    f: ReplayFeature,
    hp: HypotheticalPosition,
    threshold: ThresholdSet,
): CloseReason | null {
    // Priority 1: trend_shift
    if (f.regime && f.regime.trend > REGIME_TREND_CLOSE) return 'trend_shift';

    // Priority 2: il_threshold（目前 backtest 未追蹤累計 IL，跳過）
    // TODO(future): 追蹤 cumulativeIlPct 後啟用
    // if (hp.cumulativeIlPct !== null && hp.cumulativeIlPct > IL_THRESHOLD_PCT) return 'il_threshold';

    // Priority 3: opportunity_lost — score 低於 close threshold
    if (f.mcScore !== null && f.mcScore < threshold.sharpeClose) return 'opportunity_lost';

    // Priority 4: timeout — out-of-range > 4h（用 replay 時間軸）
    if (
        hp.outOfRangeSinceMs !== null &&
        (f.ts * 1000 - hp.outOfRangeSinceMs) > OUT_OF_RANGE_TIMEOUT_MS
    ) {
        return 'timeout';
    }

    return null;
}

// ─── V3LpReplayDriver ────────────────────────────────────────────────────

export class V3LpReplayDriver {
    /** TVL 乘數（用於 fee 計算的 pool TVL 調整，預設 1.0） */
    tvlMultiplier: number;

    constructor(private readonly features: ReplayFeature[], tvlMultiplier = 1.0) {
        this.tvlMultiplier = tvlMultiplier;
    }

    /** 設定 TVL 乘數（供 sensitivityRunner 在不同情境間切換） */
    setTvlMultiplier(m: number): void {
        this.tvlMultiplier = m;
    }

    /**
     * 執行 replay，回傳所有已結算的 PositionOutcome[]。
     *
     * @param threshold 三軸門檻（sharpeOpen / sharpeClose / atrMultiplier）
     * @param mode 'raw'（無 hysteresis）或 'full-state'（2-cycle gate）
     */
    run(threshold: ThresholdSet, mode: 'raw' | 'full-state'): PositionOutcome[] {
        const outcomes: PositionOutcome[] = [];
        /** 活躍的 hypothetical positions（key = positionId） */
        const activePositions = new Map<string, HypotheticalPosition>();
        /**
         * full-state mode：per-pool 連續高分 cycle 計數。
         * key = poolId, value = 連續 score > sharpeOpen 的 cycle 數。
         */
        const openScoreStreak = new Map<string, number>();

        for (let i = 0; i < this.features.length; i++) {
            const f = this.features[i];

            // ── 跳過 currentPriceNorm === null 的 cycle（歷史不足） ──────
            if (f.currentPriceNorm === null) continue;

            // ── 處理已有倉位的 pool ────────────────────────────────────────
            const existingPosId = this.findActivePositionForPool(activePositions, f.poolId);
            if (existingPosId !== null) {
                const hp = activePositions.get(existingPosId)!;

                // Hard cap 7d 檢查
                if (f.cycleIdx - hp.openedAtCycle >= HARD_CAP_CYCLES) {
                    this.settlePosition(hp, f, 'hard_cap_7d', outcomes);
                    activePositions.delete(existingPosId);
                    continue;
                }

                // 追蹤 out-of-range 狀態
                this.updateOutOfRange(hp, f);

                // 檢查是否穿出 band → evaluateExit（inline，使用 threshold.atrMultiplier）
                const exitDecision = evaluateExit(
                    f.currentPriceNorm,
                    hp.PaNorm,
                    hp.PbNorm,
                    f.atrHalfWidth ?? 0.05,
                    f.regime ?? { range: 0.5, trend: 0.3, neutral: 0.2 },
                    threshold.atrMultiplier,
                );

                if (exitDecision === 'rebalance') {
                    // Rebalance：close old + deduct gas + open new
                    hp.feesAccumulated = Math.max(0, hp.feesAccumulated - REBALANCE_GAS_USD);
                    this.settlePosition(hp, f, null, outcomes);
                    activePositions.delete(existingPosId);

                    // 開新倉（如果 feature 有足夠資料）
                    const newHp = this.createPosition(f);
                    if (newHp !== null) {
                        activePositions.set(newHp.positionId, newHp);
                    }
                    continue;
                }

                // Close 條件（trend_shift / opportunity_lost / timeout）
                const closeReason = evaluateClose(f, hp, threshold);
                if (closeReason !== null) {
                    this.settlePosition(hp, f, closeReason, outcomes);
                    activePositions.delete(existingPosId);
                    continue;
                }

                // 繼續持有
                continue;
            }

            // ── 沒有倉位 → 考慮開倉 ──────────────────────────────────────
            const strategy = featureToStrategy(f);
            const regime = f.regime ?? { range: 0.5, trend: 0.3, neutral: 0.2 };
            const advice = recommendOpen(strategy, regime, f.poolLabel);

            if (advice === null || advice.score < threshold.sharpeOpen) {
                // 不符合開倉條件 → 重設 streak
                if (mode === 'full-state') {
                    openScoreStreak.set(f.poolId, 0);
                }
                continue;
            }

            // Score 過門檻
            if (mode === 'raw') {
                // raw mode：立即開倉
                const hp = this.createPosition(f);
                if (hp !== null) {
                    activePositions.set(hp.positionId, hp);
                }
            } else {
                // full-state mode：需 2 連續 cycle
                const streak = (openScoreStreak.get(f.poolId) ?? 0) + 1;
                openScoreStreak.set(f.poolId, streak);

                if (streak >= 2) {
                    const hp = this.createPosition(f);
                    if (hp !== null) {
                        activePositions.set(hp.positionId, hp);
                        openScoreStreak.set(f.poolId, 0); // reset after open
                    }
                }
            }
        }

        // ── End of replay：force settle 所有仍然 open 的倉位 ────────────
        const lastFeature = this.features[this.features.length - 1];
        if (lastFeature) {
            for (const [posId, hp] of activePositions) {
                this.settlePosition(hp, lastFeature, 'hard_cap_7d', outcomes);
                activePositions.delete(posId);
            }
        }

        return outcomes;
    }

    // ─── Private Helpers ────────────────────────────────────────────────

    /**
     * 在 activePositions 中尋找指定 pool 的活躍倉位 ID。
     * 每個 pool 同時只有一個倉位。
     */
    private findActivePositionForPool(
        positions: Map<string, HypotheticalPosition>,
        poolId: string,
    ): string | null {
        for (const [id, hp] of positions) {
            if (hp.poolId === poolId) return id;
        }
        return null;
    }

    /** 建立新 hypothetical position。 */
    private createPosition(f: ReplayFeature): HypotheticalPosition | null {
        if (f.currentPriceNorm === null || f.PaNorm === null || f.PbNorm === null) {
            return null;
        }
        return {
            positionId: `${f.poolId}:${f.ts}`,
            poolId: f.poolId,
            openedAtCycle: f.cycleIdx,
            openedAtTs: f.ts,
            openPriceNorm: f.currentPriceNorm,
            PaNorm: f.PaNorm,
            PbNorm: f.PbNorm,
            initialCapital: INITIAL_CAPITAL,
            feesAccumulated: 0,
            outOfRangeSinceMs: null,
            closedAtCycle: null,
            closedAtTs: null,
            closeReason: null,
        };
    }

    /** 追蹤 out-of-range 狀態（進出 band 時更新 outOfRangeSinceMs）。 */
    private updateOutOfRange(hp: HypotheticalPosition, f: ReplayFeature): void {
        if (f.currentPriceNorm === null) return;

        const inRange = f.currentPriceNorm >= hp.PaNorm && f.currentPriceNorm <= hp.PbNorm;
        if (inRange) {
            hp.outOfRangeSinceMs = null; // 回到 range 內，重設
        } else if (hp.outOfRangeSinceMs === null) {
            hp.outOfRangeSinceMs = f.ts * 1000; // seconds → ms
        }
        // 已經 out-of-range 且記錄過 → 不更新
    }

    /**
     * 結算倉位：填寫 close 欄位，呼叫 computeOutcome 產出 PositionOutcome。
     *
     * @param closeReason null 表示 rebalance close（非標準 CloseReason）
     */
    private settlePosition(
        hp: HypotheticalPosition,
        closeFeature: ReplayFeature,
        closeReason: CloseReason | 'hard_cap_7d' | null,
        outcomes: PositionOutcome[],
    ): void {
        hp.closedAtCycle = closeFeature.cycleIdx;
        hp.closedAtTs = closeFeature.ts;
        hp.closeReason = closeReason as HypotheticalPosition['closeReason'];

        // 收集 lifecycle features
        const lifecycleFeatures = this.features.filter(
            f => f.poolId === hp.poolId &&
                 f.cycleIdx >= hp.openedAtCycle &&
                 f.cycleIdx <= closeFeature.cycleIdx,
        );

        const outcome = computeOutcome(hp, lifecycleFeatures, this.tvlMultiplier);
        outcomes.push(outcome);
    }
}
