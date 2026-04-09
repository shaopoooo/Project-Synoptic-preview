# TODOS

## P1: GP 計算量估算 (Phase 3 前置)
- **What:** 在 Phase 1 完成後，用 PricePathGenerator 跑 timing benchmark
- **Why:** 200 pop × 50 gen = 10,000 MC evaluations，單線程 Node.js 可能數小時。需要決定是否用 worker threads 或降低 MC paths
- **Context:** Phase 3 GP 引擎的可行性取決於此
- **Depends on:** Phase 1 完成

## Deferred from CEO Plan
- **LPStrategyGenome evolution (P2):** 等 RegimeGenome 穩定後再加入
- **Unsupervised regime labeling (P3):** HMM/clustering 替代硬分類器打標
