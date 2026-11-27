# TASK-004 回歸與 Desktop 驗收

狀態為 **done**，依賴 TASK-002、TASK-003。

## 本機驗證

- `npm test` 通過 899 項，0 項失敗。新增回歸斷言涵蓋延遲初始化、快取重用、缺入口、拒絕、未填入快取與狀態格式錯誤。
- `npm run lint` 為 0 個錯誤、3 個既有警告。`git diff --check` 和 Desktop E2E 檔案語法檢查通過。
- Desktop E2E 的 API 前置判斷會先載入 Replay。Live 驗收範圍是唯讀檢查與診斷，Replay 啟動、步進、停止與模擬交易屬獨立的 opt-in E2E。

## TradingView Desktop 3.5.1 驗收

使用既有 CDP target 指定圖表。每條命令在不同頁面驗證，執行前讀到的 `_replayApi` 均為 `null`。

| 命令 | 結果 |
| --- | --- |
| `tv compatibility check --profile read-only --fixture config/compatibility/fixture.json` | `dev` 的 Pane 0 通過。`REPLAY-001` 通過，30 項通過、0 項失敗、0 項受阻、7 項依設定排除。 |
| `tv replay status` | `is_replay_available: true`、`is_replay_started: false`。 |
| `tv discover` | `apis.replayApi.available: true`。 |
| `tv ui-state` | `replay.available: true`、`replay.started: false`。 |

驗收於 2026-11-27 11:34（台北時間）完成。`tv compatibility status` 為 `passed`，已驗證版本為 3.5.1。冷圖表報告為 `~/.tradingview-mcp/compatibility/reports/2026-11-27T03-34-33-048Z-36fa1a3a-5cb6-48d1-80e3-1a6e85162e9a.json`。
