# 失敗復現與調查

## 環境與復現

- 實測日期為 2026-11-27。環境為 macOS arm64、TradingView Desktop 3.5.1（build 8500）、Electron 45.2.1、Chromium 156.0.8078.75、Node 26.12.1、CDP `127.0.0.1:9222`，`tv` 基準為 `f56cc49`。
- 使用 `config/compatibility/fixture.json` 的 `dev` Layout、Pane 0，等圖表和 fixture 載入。用第一條命令確認 `_replayApi` 為 `null`、`replayApi` 為函式。

```bash
npm run --silent tv -- ui eval '({ cacheIsNull: window.TradingViewApi._replayApi === null, accessor: typeof window.TradingViewApi.replayApi })'
npm run --silent tv -- replay status
npm run --silent tv -- compatibility check --profile read-only --fixture config/compatibility/fixture.json
```

`tv replay status` 報 `Replay API not available at window.TradingViewApi._replayApi`。使用 fixture 的檢查在 11:23（台北時間）回傳 `incompatible`，28 項通過、2 項失敗、0 項受阻、7 項依設定排除。`REPLAY-001.read.capability` 的觀察值是 `found: false`，`REPLAY-001.read.state` 的觀察值是 `null`，兩項原因都是 `RETURN_SHAPE_CHANGED`。

原始報告保存在本機 `~/.tradingview-mcp/compatibility/reports/2026-11-27T03-23-21-501Z-ba4e36cc-f3f3-4ec8-bbb5-e84468010412.json`。

## 調查結果

1. `_replayApi` 是頁面 API 物件自身的欄位，初始化前的值為 `null`。原型上的 `replayApi()` 是非同步方法，在首次呼叫時載入 Replay controller，建立 API 並把實例寫回 `_replayApi`。
2. 在同一圖表呼叫 `await window.TradingViewApi.replayApi()` 後，回傳物件與 `_replayApi` 全等。取樣的 17 個方法均存在，包含 `selectDate`、`doStep`、`goToRealtime`、`stopReplay`、狀態讀取和模擬交易方法。
3. 初始化後，`tv replay status` 回傳 `is_replay_available: true`、`is_replay_started: false`、`replay_mode: "ActiveChart"`。讀取前後 Replay 按鈕的 `aria-pressed` 都是 `false`。
4. 3.5.0 在 2026-11-16、11-21 的本機報告也有相同兩項失敗，而 10-30 和 11-02 的 3.5.0 報告顯示 `REPLAY-001` 通過。歷史執行的來源指紋或測試設定有差異，且缺少初始化前的欄位觀察。只能確認 3.5.1 的執行機制，無法確定首次引入延遲初始化的版本。

唯讀能力檢查只驗證方法存在及狀態可讀。Live Replay 操作的實際行為屬於獨立的 opt-in E2E 範圍。
