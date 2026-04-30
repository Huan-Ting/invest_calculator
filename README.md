# invest_calculator_render

可直接部署在 Render 的版本，不依賴 Firebase Functions / Firestore。

## Features
- 靜態頁面：`/`
- 健康檢查：`/healthz`
- API：`GET /api/ath?symbol=QQQ`
- ATH 資料來源：Yahoo Finance chart API
- 記憶體快取（預設 12 小時）

## Local Run
```bash
cd invest_calculator_render
npm install
npm start
```

## Render Deploy
- Build Command: `npm install`
- Start Command: `npm start`
- Root Directory: `invest_calculator_render`

## Environment Variables (optional)
- `PORT` (Render 會自動提供)
- `REQUEST_TIMEOUT_MS` (default: `8000`)
- `FETCH_RETRY_COUNT` (default: `3`)
- `CACHE_TTL_MS` (default: `43200000`)

## API Contract
成功：
```json
{
  "symbol": "QQQ",
  "ath": 635.72,
  "source": "yahoo-chart-max-close",
  "asOf": "2026-04-30T13:15:00.000Z",
  "cached": false
}
```

失敗：
```json
{
  "error": {
    "code": "INVALID_SYMBOL",
    "message": "Unsupported symbol"
  }
}
```
