---
paths: ["**/*"]
alwaysApply: true
description: "安全性原則"
---

# 安全性原則

- 私鑰與 API Key 僅存於 `.env`，**絕對禁止** commit 到程式碼
- 所有外部呼叫必須有錯誤處理與降級機制
- Dry Run 模式下不得執行真實交易

## npm 套件供應鏈安全

- **版本年齡**：安裝任何新套件前，確認該版本發布已滿 7 天（用 `npm view <package> time --json` 查詢）；新鮮版本可能為供應鏈攻擊載體
- **禁止浮動版本**：`package.json` 中禁止使用 `^` 或 `~` 前綴，所有版本號必須精確固定（例如 `"ethers": "6.13.5"`）
- **精確鎖定**：`package-lock.json` 必須 commit，且 integrity hash 不得手動修改
- **部署安裝**：CI / 生產環境一律用 `npm ci`（讀取 lock file），禁止用 `npm install`