# History To System Design

Status: `done`，實作、本機自動化驗證、使用文件與 [Desktop live 驗證](./LIVE_VERIFICATION.md) 已完成。
本設計依據 [需求規格](./README.md)，實作細節見 [Low level design](./LLD.md)。

## Purpose and behavior

在既有 `tv history` 上增加選用的 `--to`，讓使用者透過 `--from --to`
取得指定時間區間的 OHLCV。重用現有圖表讀取與向過去載入的流程，
將日期解析、區間驗證與有效資料判斷集中在共用 core。

| Input | Behavior |
| --- | --- |
| 不提供日期 | 取得圖表可提供的全部歷史資料，受既有安全上限限制。 |
| 僅提供 `--from` | 取得起始時間至圖表當前可用的最新 bars，保留原有邏輯。 |
| 同時提供 `--from --to` | 取得符合 `from <= bar.time <= to` 的 bars。 |
| 僅提供 `--to`，或搭配空白 `--from` | 在圖表操作前拒絕，提示 `--to requires --from`。 |

未提供 `to` 時不產生系統時間的截止值，也不加入 `Date.now()` 篩選。
指定 `to` 時，依 bar 自身時間戳決定是否保留；不拆分跨越截止點的 bar。
若截止日期是假日，實際最後一筆會是區間內最後可用的交易資料。

## Date semantics

`from` 與 `to` 使用同一個 parser，沿用現有 `parseHistoryFrom()` 的辨識方式。
ISO 日期／時間與既有可辨識的 Unix 秒／毫秒均正規化為 Unix 秒。
帶時區的 ISO 時間依其 offset 轉換；純日期 `2026-06-30` 為 UTC 當日零時。
無 offset 的日期時間沿用 `Date.parse()` 的執行環境規則；使用範例以明確 offset 或 `Z` 表示。

純日期的 `to` 不自動延伸至日末；若要包含完整一天，應提供明確日末時間與時區。
此 change 不新增交易所時區、交易日曆或另一套日期格式。

## Components and responsibilities

| Component | Responsibility |
| --- | --- |
| `src/cli/commands/data.js` | 註冊 `--to`、更新 help、執行純參數 preflight，再準備 Pane context 與呼叫 core。 |
| `src/core/data.js` 的日期 helpers | 共用解析、必要參數及區間順序驗證，產生標準化起訖時間。 |
| `src/core/data.js` 的 history loader | 保留圖表鎖、切換／還原、向過去載入、去重、排序與停止條件，加入區間判斷。 |
| `src/core/time.js` | 沿用 Unix 秒與 ISO companion 欄位轉換。 |
| `writeHistoryOutput()` | 沿用相同結果寫入 JSON 檔案，stdout summary 不包含 bars。 |

`src/core/index.js` 已透過 `data` namespace 匯出 `data.js`，不需新增 namespace。
MCP `data_get_history` 的 schema 維持不提供 `to`；其共用 core 結果會增加兩個 nullable metadata 欄位。

## Execution flow

```text
tv history options
  → CLI date preflight using shared normalizeHistoryRange
  → withPaneContext and prepareContext
  → getHistory and existing chart data lock
      → validate safety limits and revalidate raw date options
      → read original chart state
      → switch symbol or timeframe when requested
      → read initial source snapshot
      → retain matching bars in time-keyed Map
      → evaluate coverage and safety limits
      → request older data and poll source progress as needed
      → sort, apply shared range predicate and retain latest max_bars
      → build result from actual returned bars
      → existing finally restores symbol or timeframe when required
  → stdout JSON or existing JSON file output
```

CLI preflight 必須在 `withPaneContext()` 之前。該 wrapper 會先呼叫
`prepareContext()`，可能 attach Tab 或 focus Pane；只在 loader 內驗證會太晚。
直接呼叫 core 的使用者也必須取得相同驗證，因此 core 仍會自行驗證。
兩次驗證共用純函式；不傳入可跳過驗證的旗標。

## Source progress and result selection

分頁進度與回傳資料分開管理：來源 snapshot 的 `first_time`、`more` 用於判斷
是否涵蓋 `from`、資料是否耗盡與 request 是否有進展；Map 僅保存符合區間的 bars。
即使本批全部晚於 `to`，只要來源向過去移動，就繼續載入。
不能以篩選後的空集合判定來源讀取失敗或沒有進展。

`max_bars` 計算區間內去重後的筆數，超量時保留區間內最新 N 筆並升序輸出。
晚於 `to` 或早於 `from` 的 bars 不保存到結果 Map，避免大量近期資料累積於 CLI 記憶體。
來源快照與 TradingView 圖表本身仍可能包含區間外資料；`max_bars` 並非整體記憶體上限。

沿用 `max_requests`、`bars_per_request` 與現有 polling。即使尚未抵達 `to`，
向過去載入的 requests 仍計入上限；不因資料較舊而自動提高限制。

## Completion and output contract

沿用現有停止原因及優先順序，詳見 LLD。涵蓋 `from` 或來源耗盡可回傳
`complete: true`；因筆數、請求次數、讀取失敗或無進展停止則為 `false`。
`complete` 描述此次載入是否依既有規則完成，不保證每個交易時段都有 bar，
也不保證資料時間精確等於使用者指定的端點。

回傳新增 `requested_to` 與 `requested_to_iso`，記錄使用者明確指定的上界；
未提供 `to` 時兩者為 `null`。既有 `requested_from` 與相關欄位不變。
`period`、`bar_count` 與 `bars` 一律根據區間篩選及筆數裁切後的結果產生。

無符合 bar 時仍拋出錯誤，不回傳沒有端點的成功結果。
Metadata-only、包含 bars 與檔案輸出共用同一次 history 讀取結果，無第二次查詢。
`--output` 的預設防覆寫與 `--force` 行為沿用現況。

## Compatibility and scope

不變更 `from` 的既有日期辨識、預設上限、向過去載入方向、鎖或 symbol/timeframe
還原規則；不為此功能新增 Replay、圖表可視範圍操作或額外資料供應來源。
資料可用性仍取決於 TradingView 圖表、帳號及行情來源。

新增 metadata 為 additive result change，既有 MCP 和 core 呼叫者需容許額外欄位。
無 `to` 時，資料選取與停止行為應與原本相同。

## Verification

以 mocked runtime 驗證日期端點、分頁進度、有效筆數、停止原因與還原；
以 CLI 測試驗證 help 與無效日期在 CDP discovery 前失敗。
假日以區間內缺少當日 bar 的 fixture 驗證，不引入交易日曆依賴。
測試案例與命令詳見 [LLD](./LLD.md#verification-plan)。
