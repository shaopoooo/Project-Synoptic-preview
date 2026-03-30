---
name: security-checker
description: 掃描程式碼中是否包含敏感資訊、硬編碼私鑰、API Key 或 .env 洩漏風險。
---

# 安全性檢查器

- 禁止任何硬編碼私鑰、API Key、RPC URL
- 敏感資訊必須只來自 `process.env`
- 檢查是否有 console.log 意外印出敏感資料
- Dry Run 模式下絕對禁止真實交易

**執行**：每次產生新程式碼或修改後自動掃描，並在發現問題時立即警示。