# 建置與開發指令

## 執行指令

| 指令 | 用途 |
|------|------|
| `npm run dev` | 完整開發執行（載入 `.env`） |
| `npm run dev:fast` | 快速啟動（跳過初始區塊掃描） |
| `npm test` | 單元測試（Jest） |
| `npm run backtest` | 歷史回測 |
| `npm run dryrun` | Dry Run（不執行真實交易） |

## 套件安裝鐵律

安裝任何新套件前必須全部滿足：

1. **版本年齡 ≥ 7 天**
   ```bash
   npm view <package> time --json
   ```
   新鮮版本可能是供應鏈攻擊載體。

2. **版本號精確固定**
   - ✅ `"ethers": "6.13.5"`
   - ❌ `"ethers": "^6.13.5"`
   - ❌ `"ethers": "~6.13.5"`

3. **Lock file 管理**
   - `package-lock.json` 必須 commit
   - 部署 / CI 一律使用 `npm ci`（讀 lock file），禁止 `npm install`
   - `integrity` hash 禁止手動修改
