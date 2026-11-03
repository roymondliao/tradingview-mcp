# History To Delivery Evidence

## TASK 001 implementation

Date: 2026-11-03。Branch: `codex/history-to`。Runtime: Node `v26.12.1`。

- Core 增加共用日期解析與 `normalizeHistoryRange()`，在圖表讀取前驗證。
- CLI 註冊 `--to`，由 `runHistoryCommand()` 在 Pane context 準備前驗證並傳遞參數。
- 區間內累積、去重及筆數判斷共用範圍條件，來源分頁進度不受輸出篩選影響。
- 回傳新增 requested-to metadata，實際 period 與檔案內容使用同一份結果。

## Automated checks

| Command | Result |
| --- | --- |
| `node --test tests/data/unit/history.test.js tests/cli/integration/router.test.js` | PASS，57 tests、0 failures；含 17 個 history 測試。 |
| `npm run lint` | PASS，0 errors、3 個既有 unused-variable warnings。 |
| `git diff --check` | PASS。 |

Lint warnings 位於 `src/core/data.js` 的兩個既有 catch variables，以及
`src/tools/watchlist.js` 的一個既有參數；本次未修改這些程式段落。

## Covered behavior

- ISO 純日期 UTC 零時、明確時區、Unix 秒／毫秒與 Unix zero 的共同解析。
- 缺少／空白 `from`、空 `to`、不可解析日期及反向區間在 runtime 或 context 操作前失敗。
- CLI subprocess 在不可用 CDP port 下仍先回報日期參數錯誤。
- 多批資料晚於 `to` 時繼續載入；區間內去重、相等端點與超量裁切。
- N 等於上限且已涵蓋 `from` 為完整；N 超量時依原順序標示未完整。
- 實際末筆早於指定 `to`、有無上界時不同的空集合錯誤訊息。
- 無 `to` 的原有讀取、request limit、無進展、切換／還原與防覆寫測試維持通過。
- CLI raw options 傳遞與數字轉換、還原後寫檔，以及檔案／summary 的區間與筆數一致。

## Remaining work

TASK-002 尚未完成：補齊其餘錯誤／限制回歸矩陣、更新 repo 使用說明，並記錄最終驗證。
MCP schema 保持原樣；新增 core 回傳欄位為 additive metadata。
未執行 TradingView Desktop live 驗證、提交、推送或發佈。
