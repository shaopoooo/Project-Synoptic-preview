---
name: dex-adapter-generator
description: 快速產生新 DEX 的 Adapter（Uniswap V3/V4、Aerodrome、PancakeSwap 等）。使用時機：需要支援新 DEX 時。
---

# DEX Adapter 產生器

請依照現有 Adapter 模式產生新 DEX 的 Service：
- 實作 getPoolInfo、getPrice、getFee 等方法
- 封裝在 src/services/dex-adapters/ 底下
- 符合 Phase 0/1 分離原則
- 使用 TypeScript strict mode

產生後請立即執行 phase-checker skill 驗證。