---
id: TASK-001
title: History CLI and Core Date Range
status: done
phase: history-to
depends_on: []
blocks:
  - TASK-002
scope: history-date-range
---

# TASK-001 History CLI and Core Date Range

## Goal

依 [需求規格](./README.md) 為 `tv history` 增加 `--to`，讓共用 history
讀取流程能正確處理起訖區間及載入限制。

## Implementation

已完成以下三部分；詳細介面及停止優先序以 [LLD](./LLD.md) 為準。

### Shared date validation

修改 `src/core/data.js`：

- 將 `parseHistoryFrom()` 改為私有 `parseHistoryDate(value, name)`，保留現有
  `Date.parse()`、數字分支、毫秒門檻及 Unix 秒精度，依參數名稱產生錯誤訊息。
- 匯出純函式 `normalizeHistoryRange({ from, to })`，回傳 `{ fromTime, toTime }`。
- 提供 `to` 時要求有效 `from`；缺少、空字串或純空白 `from` 提示
  `--to requires --from`。數字 `0` 不視為缺少。
- 拒絕明確傳入的空 `to`、不可解析日期及 `fromTime > toTime`；相等端點合法。
- `_getHistoryInternal()` 新增 `to`，在建立 runtime 及讀取圖表前呼叫 validator。

### CLI preflight and wiring

修改 `src/cli/commands/data.js`：

- 註冊 `--to`，help 說明格式及必須搭配 `--from`，不新增短旗標。
- 將原 handler 本體移至匯出的 `runHistoryCommand(opts, deps = {})`，註冊時由
  `handler: opts => runHistoryCommand(opts)` 呼叫。
- 保留 removed-options 檢查，隨後在 `withPaneContext()` 前呼叫共用 validator，
  避免無效日期仍觸發 CDP discovery、Tab attach 或 Pane focus。
- Handler 接受 LLD 定義的 validator、context、core 及 output 函式替身，
  預設使用原有實際函式，供 TASK-002 隔離測試。
- 將原始 `from`／`to` 傳給 core，不以 truthiness 隱藏空值；保留既有 option 轉換與輸出流程。

### Range loading and result

修改 `src/core/data.js` 的 loader：

- 定義共用 `inRange()`，使用包含端點的條件；Map 僅累積符合區間的 bars，
  以時間戳去重，使用 Map 筆數判斷 `max_bars`。
- 來源 snapshot 的 `first_time`／`more` 保持原始值，繼續用於 coverage 及分頁進度。
  本批無符合資料不等於無進展，晚於 `to` 的 bars 不阻擋繼續載入。
- 保留原有停止優先序、request/poll、圖表鎖及 symbol/timeframe 還原流程，
  不變更 runtime 的 `readSnapshot(beforeTime)` 契約。
- 最終使用相同 predicate 篩選、升序排序，超量時保留區間內最新 N 筆。
- 新增 nullable `requested_to`／`requested_to_iso`；`period`、`bar_count` 及
  `bars` 使用裁切後的結果，summary 與檔案輸出共用同一份資料。
- 有 `to` 且無匹配資料時使用 date-range 錯誤；無 `to` 時保留原有 start-time 錯誤。
- 僅傳 `from` 時維持取得至圖表最新可用資料，不新增系統時間截止條件。

元件責任與完整執行流程見 [System design](./SYSTEM_DESIGN.md)。
MCP schema、共用 Pane wrapper、時間轉換 helper 及 runtime dependencies 不在修改範圍。

## Acceptance criteria

- [x] CLI 可將 `--to` 正確傳到 core，未提供時維持既有行為。
- [x] CLI 在 Pane context 前驗證日期；直接 core 呼叫也在 runtime 操作前驗證。
- [x] 僅提供 `from` 時，取得起始時間至圖表當前可用最新 bar，維持原有篩選邏輯。
- [x] 單獨傳入 `to` 或搭配空值 `from`，在圖表操作前報錯並提示 `--to requires --from`。
- [x] 明確傳入的空 `to`、無效日期與反向區間遭拒；Unix `0` 與相等端點合法。
- [x] 兩端共用原有日期辨識，純日期為 UTC 零時，不自動延伸到日末。
- [x] 區間外資料不占用 `max_bars`，來源有進展但無匹配 bars 時仍繼續載入。
- [x] 去重、超量裁切與停止優先序符合 LLD，相等及超量筆數不混淆完成狀態。
- [x] 實際範圍、筆數與 requested-to metadata 符合需求。
- [x] 空集合錯誤依有無 `to` 使用對應訊息；檔案輸出不早於 core 還原完成。
- [x] 原有請求上限、停止原因、圖表還原及 MCP 無 `to` 呼叫保持相容。

必要回歸測試與 lint 已通過，詳見 [驗證紀錄](./DELIVERY_EVIDENCE.md)。
MCP schema 未修改；無 `to` 的資料路徑由既有 core 測試驗證，尚未執行 Desktop live 測試。
後續由 [TASK-002](./TASK-002-tests-documentation.md) 補齊其餘測試矩陣與使用文件。
