# Feature: <名稱>

> 本檔案由 gstack 在 Phase 1 結尾產出，作為交接給 superpowers (Phase 2) 的正式契約。
> superpowers 執行階段**只讀不寫**；若需調整，必須退回 Phase 1 由 gstack 更新。
>
> **📐 命名規則（CLAUDE.md line 101 強制）**：
> - **Stage**：可上線里程碑，用**數字**命名：`Stage 1`、`Stage 2` …（**不**用 `Stage A/B/C`）
> - **Group**：subagent 並行邊界，用 **Stage 數字 + 字母**：`Group 1.A`、`Group 1.B`、`Group 2.A` …
> - **Task**：TDD 最小步驟，用 **Stage + Group + 數字**：`Task 1.A.1`、`Task 1.A.2` …
> - 1 PR ≥ 1 Stage；同 Stage 內不同 Group 可並行；同 Group 內 Task sequential

## Context（為何要做）
- 來源：`/office-hours` / `/plan-eng-review` 的討論日期與結論
- 動機與商業價值：

## Decisions（已定案，執行階段不得動搖）
- 採用 X 而非 Y，因為 ...
-

## Rejected（已否決，subagent 不得再提）
- ❌ 方案 A：原因
- ❌ 方案 B：原因

## Constraints（必須遵守的專案規則）
- 參照 `CLAUDE.md` 與 `.claude/rules/` 的對應條目
- Phase 0 / Phase 1 分離原則
- Pure Function、BigInt、集中於 `utils/math.ts`
- TypeScript strict、禁止 `any`
- RPC 呼叫必須包 `rpcRetry`
- 其他專案特定約束：

## Interfaces（API 契約）
```ts
// 函式簽名、型別定義、錯誤型別
```

## Test Plan（TDD 起點，RED 階段的測試清單）
- [ ] RED: 給定 X 條件，應回傳 Y
- [ ] RED: 邊界情況 Z 應拋出錯誤
- [ ]

## Tasks（subagent 執行順序）
1.
2.
3.
