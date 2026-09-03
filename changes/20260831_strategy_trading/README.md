---
id: FEATURE-20260831-STRATEGY-TRADING
title: Strategy Trading Data Workflow
status: planned
created: 2026-08-31
scope:
  - watchlist
  - tab-layout-pane
  - strategy-instance
  - strategy-report
  - strategy-trades
  - local-export
---

# Strategy Trading Data Workflow

Status: `planned`

## Objective

建立可靠且可驗證的 Strategy Trading 匯出流程。CLI 是主要功能入口，必須在明確的 TradingView Tab、Chart Layout、Pane 與 Strategy Instance context 下，依序切換 Watchlist 中的 Symbol，等待 Strategy Tester 完成該 Symbol 的最新計算，取得 Strategy Report 與完整 Strategy Trading Data，核對關鍵績效數據後才將結果寫入指定目錄。MCP 後續映射與 CLI 相同的 Core workflow，不建立另一套流程。

此文件是本 feature 的需求與資料 contract。Implementation Tasks 與 LLD 必須以本文件為依據，不得回到依賴固定延遲、隱式 Strategy 選擇或只讀取最近 N 筆 Trades 的舊流程。

Core module boundaries、dependency direction、CLI response／output semantics 與 testing architecture 定義於 [`LLD.md`](./LLD.md)。Tasks 已依 vertical slices 與 dependency 拆分；[`TASK-001`](./TASK-001-runtime-contract-discovery.md) 已完成 live contract discovery，結果固定於 [`RUNTIME_CONTRACT.md`](./RUNTIME_CONTRACT.md)。

## Approved CLI contract

```text
strategy active
strategy trading-report <entity-id> --symbol <symbol>
strategy trading-data <entity-id> --symbol <symbol>
strategy trading-export <entity-id> --symbol <symbol>
strategy trading-export <entity-id> --watchlist active
```

- `strategy select` 不屬於 target CLI；每個需要 Strategy Data 的 command 自行驗證 `entity_id`，找不到或 type 錯誤時回傳 error。
- `trading-report` 與 `trading-data` 是最小 CLI use cases；高階 `trading-export` 重用其背後 Core modules，不啟動低階 CLI subprocess。
- `trading-data` default external format 是 JSON，並支援 JSONL／CSV；canonical JavaScript object model 才是 format conversion 的 source of truth。
- `trading-export` 可處理單一 Symbol，或依 Active Watchlist Snapshot sequential 處理全部 Symbols。

## Existing capabilities and gaps

Repository 目前已有以下基礎能力：

- 使用 `tab_index`、`url_chart_id`、runtime `layout_id`、account `saved_layout_id` 與 `pane_index` 定位操作 context。
- 切換 Pane 的 Symbol／Timeframe 並等待 Chart ready。
- 使用 Strategy Instance `entity_id` 選擇 Strategy Tester 的 Active Strategy。
- 取得 Strategy Report、raw Orders、paired Trades，以及可用時的 Equity。
- Strategy Trades response 已保留 Unix timestamp，並提供相對應的 UTC ISO 8601 `*_iso` 欄位。

目前仍有以下缺口：

- `report_ready` 只代表 Report 當下可讀，無法證明它屬於剛切換完成的 Symbol／Timeframe 或最新 Inputs。
- Strategy Inputs 更新後只會回報 `report_state: recalculating`，尚未等待並驗證新 Report 完成。
- Trades／Orders 最多只回傳尾端 5,000 筆，沒有能取得完整資料的 offset／cursor contract。
- 現有 batch flow 使用固定等待時間，沒有驗證 inner result、snapshot 一致性或完整 Trades。
- 尚無穩定的指定目錄輸出、staging、atomic publish、manifest 與 reconciliation contract。
- 尚未完整盤點 TradingView runtime 的 raw Trade payload 是否能覆蓋 Desktop CSV 的所有資料語意。

## Terminology and boundaries

長期 UI／domain 名詞以 [`docs/terminology.md`](../../docs/terminology.md) 為準。本 feature 使用以下資料名詞：

- **Watchlist Snapshot**：一次執行開始時取得的 Watchlist 名稱、ID、Symbol 順序與內容。執行途中 UI 對 Watchlist 的修改不應改變本次工作集合。
- **Strategy Instance**：存在於指定 Pane 的 Strategy Study Instance，以 `entity_id` 唯一識別。
- **Market History Data／Chart History Data**：特定 Symbol 與 Timeframe 的歷史 OHLCV Bars，是 Strategy 回測使用的市場輸入資料；由 repo 的 `history` 功能負責載入及匯出，不屬於本 feature 的輸出。
- **Strategy Report**：Strategy Tester 對指定 Strategy、Symbol、Timeframe、Inputs 與測試範圍計算出的回測結果，包含 Performance Metrics 與 Strategy Trading Data。
- **Strategy Trading Data**：Strategy Tester「交易清單」中由 Broker Emulator 計算出的 paired Strategy Trades。它記錄 Strategy 回測的 Entry／Exit、價格、數量與損益等結果；不是 OHLCV，也不是 Broker Account 實際成交。對外匯出的 CSV 應保有 TradingView Desktop 的 Entry／Exit 雙列語意。
- **Order**：`ordersData()` 提供的原始 order event。Order 不等同 Trade，本 feature 不將 Order 靜默命名為 Trade。
- **Closed Trade**：已有有效 Exit 的 Trade。勝率與交易次數只使用 Closed Trades；其淨損益是 Report 總損益的主要來源。
- **Open Trade**：尚未 Exit 的 Strategy Trade。其浮動損益不納入 Report 總損益，勝率與交易次數也不納入；但已實際收取的 commission 會調整 Report 總損益。
- **Broker Execution／Actual Broker Trade**：送往真實 Broker Account 並實際成交的交易。本 feature 不讀取或匯出這類資料。
- **Snapshot**：可證明 Report 與全部 Trade batches 屬於同一個 Tab、Layout、Pane、Strategy、Symbol、Timeframe、Inputs 與計算結果的識別資料。
- **Staging Output**：尚未通過完整性與 reconciliation 驗證的暫存檔案，不得視為成功匯出結果。

### Data-domain boundary

Market History Data 與 Strategy Trading Data 的關係是「回測輸入」與「回測輸出」，不是同一個 dataset：

```text
Market History Data
Timestamp + OHLCV Bars
        │
        │ 作為 Strategy 計算輸入
        ▼
Pine Strategy + Inputs + Properties
        │
        │ TradingView Broker Emulator
        ▼
Strategy Report
├── Performance Metrics
└── Strategy Trading Data
    ├── Entry
    ├── Exit
    ├── Quantity
    ├── Net Profit
    └── Trade-level Metrics
```

本 feature 只匯出 Strategy Report 與 Strategy Trading Data。它不呼叫 Chart History Loader 來分批取得 Strategy Trades，也不輸出 Symbol 的 OHLCV 或 Volume。Regular／Deep Backtesting 決定 Strategy Report 涵蓋的計算資料範圍；無論使用哪種模式，匯出對象仍是該次 Strategy Report 的回測交易結果。

## Fixed execution context

每次執行開始前必須固定以下 context：

```text
TradingView Desktop
└── Tab
    └── Chart Layout
        └── Pane
            └── Strategy Instance
                ├── Symbol
                ├── Timeframe
                ├── Inputs
                ├── Strategy Report
                └── Strategy Trading Data
```

Context resolution 的順序為：

```text
Tab selector → Chart Target / chart-id → Layout → pane_index → Strategy entity_id
```

其中Tab inventory與已attach Pane必須使用同一個Layout Identity adapter，避免兩條路徑對同一個Chart Layout產生不同結果：

- `url_chart_id`由CDP `/json/list`的Chart URL取得，不依賴TradingView runtime readiness。
- Desktop 3.4.0的runtime `layout_id`優先由`_saveChartService.layoutId()`取得；provider暫時不可用時可使用`url_chart_id`作為候選，但attach後仍必須重新讀取並嚴格驗證。
- Account `saved_layout_id`不等同runtime `layout_id`；它由`getSavedCharts()`catalog以`catalog.url === layout_id`映射至`catalog.id`。
- `tab list`對每個Chart target執行bounded metadata retry，並回傳`metadata_status`、`metadata_attempts`及bounded `metadata_error`；不得將失敗靜默表示為正常的`layout: null`。
- `--saved-layout-id`需要成功取得Saved Layout mapping；metadata unavailable時必須回傳明確diagnostic，不可猜測Tab。`--layout-id`可利用3.4.0已驗證的URL identity縮小候選，再由Pane context readback確認ownership。

要求如下：

- 不得假設 `/json/list` 第一筆 target、第一個 Pane 或第一個 report-ready Strategy 就是使用者指定的對象。
- 所有 Symbol switching、Report read 與 Trade read 都必須使用相同的 resolved context。
- 使用者在 Desktop 手動切換 Tab 或 Pane，不得使正在執行的工作靜默轉向其他 context。
- 若指定 context 已不存在、ownership 改變或無法唯一解析，該 Symbol 必須失敗，不可猜測 fallback。
- Timeframe、Strategy Inputs 與 Strategy `entity_id` 在一次 Watchlist run 中固定；若未來支援變更，必須建立新的 snapshot。

## End-to-end workflow

### 1. Initialize the run

1. 解析並固定 Tab、Layout、Pane 與 Strategy Instance。
2. 讀取 Active Watchlist，建立不可變的 Watchlist Snapshot。
3. 記錄原始 Symbol／Timeframe，供 run metadata 使用；是否於結束後恢復由後續 CLI contract 明確定義。
4. 驗證指定輸出目錄可使用，建立本次 run 的 staging area。

### 2. Process each Symbol sequentially

對 Watchlist Snapshot 中每個 Symbol，依序執行：

1. 將指定 Pane 切換至該 Symbol，保留固定 Timeframe。
2. 等待 Chart readback 確認 Symbol／Timeframe 已套用，且 Strategy 可以針對該 context 進行計算。此步驟不代表執行 Chart History export 或載入 OHLCV batches。
3. 重新選擇並驗證指定 Strategy Instance。
4. 等待 Strategy Tester 對新 Symbol 完成 fresh calculation；不可將切換前仍可讀的舊 Report 視為成功。
5. 讀取 Strategy Report A，建立或取得 snapshot identity。
6. 從同一份 `reportData().trades` 結果集合，以 deterministic record batches 取得完整 Strategy Trading Data；每一批都必須屬於相同 snapshot。
7. 將 raw Trade payload 正規化為 repo-owned canonical trade schema。
8. 再次讀取 Strategy Report B，確認 Report A、Trades 與 Report B 的 context／snapshot 一致。
9. 以 Closed Trades 計算勝率與交易次數，並以 Closed P&L 扣除 Open 已收 commission 計算總損益，再與 Report B 比對。
10. 驗證成功後才將 staging artifacts atomic publish 到該 Symbol 的正式輸出目錄。
11. 將該 Symbol 的成功或失敗結果寫入 run manifest，再處理下一個 Symbol。

### 3. Complete the run

- Watchlist Snapshot 中每個 Symbol 都必須有明確的 `success` 或 `failed` 結果。
- 單一 Symbol 失敗不得被標記為成功，也不得留下看似完整的正式輸出檔。
- Run summary 必須包含 requested、succeeded、failed 與 skipped counts。
- 是否採 fail-fast、continue-on-error、retry 或 resume，留待 CLI／MCP contract 規劃；無論模式為何都不得犧牲資料正確性。

## Freshness and snapshot contract

### Fresh calculation

切換 Symbol／Timeframe 或修改 Strategy Inputs 前，Core 必須保存 before-state。新結果只有在下列條件都成立時才可視為 ready：

- Chart readback 的 Symbol／Timeframe 符合 request。
- Active Strategy readback 的 `entity_id` 符合 request。
- Strategy Report 已經歷可辨識的 recalculating／generation change，或其 derived signature 已從 before-state 改變。
- Report 的關鍵 identity fields 與目前 context 一致。
- Report 在 bounded polling 期間達到穩定狀態。

TradingView 若未提供公開 generation ID，實作必須建立 deterministic derived signature；signature 的欄位與碰撞風險需在 LLD 中定義並以 live payload 驗證。單純 `report_ready === true` 不足以證明 freshness。

### Snapshot stability

取得 Trades 前後都要讀取 Report。Report A、所有 Trade batches 與 Report B 必須具有相同 snapshot identity。中途發生以下任一狀況時，本輪資料不可發布：

- Symbol、Timeframe、Pane 或 Strategy Instance 改變。
- Report generation／derived signature 改變。
- Trade total、排序基準或 pagination boundary 改變。
- Desktop 重新計算導致資料批次重複、遺漏或不再可驗證。

是否針對 stale snapshot 自動重新開始整個 Symbol，應由後續 task 定義有限次數的 retry policy；不可只重抓中間某一批後拼接。

## Complete Strategy Trading Data retrieval

### Pagination model

Strategy Trading Data 的來源是已完成 Strategy Report 中的 `reportData().trades` results。TradingView UI 沒有「page」概念，因此 public contract 不使用 `page-size`／`max-pages`；實際 API 可採 `offset + limit` 或 opaque cursor 將同一份 Trade results 分批傳回，但必須符合以下 contract：

- 排序方向固定且寫入 response，例如由最舊到最新。
- 每批 response 包含 snapshot identity 與 batch boundary。
- Response 至少能表達 `total`、`returned`、下一批位置及 `has_more`。
- Caller 能判斷資料是否完整，不能把 limit 截斷包裝成 success。
- Snapshot 改變時停止並作廢本輪所有 batches。
- Trade batching 不得呼叫 Chart History `requestMoreData()`，也不依賴 `bars_per_request`、`max_requests` 或 `max_bars`。
- `bar_index` 只表示 Entry／Exit 發生在哪一根 Bar，供圖表定位與資料驗證使用；它不是 Offset、Cursor 或下一批 Trade 的請求位置。

### Completion conditions

只有同時符合下列條件才可宣告 Strategy Trading Data complete：

- 已走訪到 snapshot 的結尾，`has_more === false`。
- 已取得的 canonical Trade 數量符合 snapshot 宣告的 closed／open Trade totals。
- Trade identity 沒有非預期重複或缺口。
- 所有批次的 context 與 snapshot identity 相同。
- Report A 與 Report B 穩定一致。

## Strategy Trading Data schema

### Desktop CSV as semantic reference

[`data/trade_sample.csv`](../../data/trade_sample.csv) 是 TradingView Desktop 下載格式的現有 sample，包含以下 17 類資料語意：

1. 交易編號
2. 類型（Entry／Exit）
3. 日期和時間
4. 訊號
5. 價格與幣別
6. 大小（數量）
7. 大小（值）
8. 淨損益與幣別
9. 報酬百分比
10. 手續費與幣別
11. 有利波動與幣別
12. 有利波動百分比
13. 不利波動與幣別
14. 不利波動百分比
15. 累計損益與幣別
16. 累計損益百分比
17. 持續時間（Bars）

TradingView 可能因 UI 語言或官方命名調整而變更 CSV column names，因此 localized header text 不得作為 parser、API 或 compatibility contract。實作應從 runtime raw payload 解析資料語意，正規化後再輸出固定欄名。

正式實作前必須以 live TradingView payload 完成 raw schema discovery，確認 `reportData().trades`／相關 source 能否提供 sample 中的全部語意，特別是：

- position value
- duration bars
- open／closed status
- currency
- Entry／Exit direction、signal 與 time

若 runtime 未提供某欄位，不得臆造數值；應使用 `null`、明確 availability metadata 或經核准的 derived rule。

### Canonical row schema

Repo-owned CSV projection 使用穩定英文欄名，不隨 TradingView locale 改變：

```text
trade_number,
leg_type,
time,
time_iso,
signal,
price,
currency,
quantity,
position_value,
net_profit,
return_percent,
commission,
run_up,
run_up_percent,
drawdown,
drawdown_percent,
cumulative_profit,
cumulative_profit_percent,
duration_bars,
status
```

Schema rules：

- `schema_version` 由 enclosing manifest／metadata 明確記錄。
- `time` 保留 TradingView 提供的 Unix timestamp；`time_iso` 為同一時間的 UTC ISO 8601 表示。
- 每筆 Trade 保留 Desktop CSV 的兩列結構：Exit row 與 Entry row。Open Trade 的 Exit row 可保留空值並以 `status: open` 表示。
- Trade-level metrics 若在 raw data 對 Entry／Exit row 重複，輸出可維持 Desktop 語意；reconciliation 只可對每個 Trade 計算一次。
- 數值在 canonical model 中保留 number，不混入 localized currency symbol、百分號、千分位或 em dash。
- `currency` 獨立保存；不同幣別的數值不可直接合計。
- `bar_index` 若 runtime 可提供，應保留在 JSON canonical model 或 metadata 中供定位與驗證使用，即使不列入第一版 CSV columns。

## Strategy Report contract

`report.json` 必須至少包含：

- schema version
- Tab、Layout、Pane context
- Strategy `entity_id`、name 與固定 Inputs identity
- Symbol、Timeframe 與 currency
- snapshot identity／derived signature
- calculation timing／freshness metadata
- Report 原始可用 metrics 的 canonical representation
- 本 feature reconciliation 使用的五項 Report metrics
- availability 與 limitation metadata

Report metric 的 localized label 不得作為唯一識別。若 TradingView runtime 使用內部 metric key，normalizer 應將其轉為穩定 canonical key。

## Reconciliation contract

### Required comparisons

Report 與 Strategy Trading Data 的正確性只以以下五項作為 reconciliation gate：

| Metric | Strategy Trading Data calculation | Match rule |
| --- | --- | --- |
| Total net profit | 所有 Closed Trades 的 `net_profit` 合計，再減去 Open Trades 已收取的 `commission` | 與 Report 總損益差值在 tolerance 內 |
| Win rate | `winning_trades / total_closed_trades * 100` | 與 Report 交易勝率差值在 tolerance 內 |
| Total trades | Closed Trade 數量 | 必須完全相等 |
| Winning trades | Closed Trades 中 `net_profit > 0` 的數量 | 必須完全相等 |
| Losing trades | Closed Trades 中 `net_profit < 0` 的數量 | 必須完全相等 |

不將下列欄位獨立作為成功 gate：

- commission（但 Open Trade 已收 commission 是計算 Total net profit 的必要調整值）
- run-up／drawdown
- Entry／Exit row count
- position value
- cumulative profit
- 每筆 Trade 的個別 P&L
- Equity Curve

這些欄位仍應在資料可用時輸出，只是不因其顯示、rounding 或版本差異而使整個 Symbol reconciliation 失敗。

### Closed, open and breakeven rules

- Open Trade 的浮動損益不計入 total net profit；已收取的 Open Trade commission 會從 Closed Trade 淨損益合計扣除，以符合 Trading Report 語意。
- Open Trades 不計入 win rate、total trades、winning trades 或 losing trades。
- `net_profit === 0` 的 Closed Trade 是 breakeven，計入 total trades，但不計入 winning 或 losing trades。
- 因此不可假設 `total trades === winning trades + losing trades`。
- 若 Report 對 breakeven 的分類語意不同，必須以 live verification 確認並在 LLD 定義，不可靜默調整。

### Numeric tolerance

第一版預設：

- Total net profit：絕對差值 `<= 0.01` currency unit。
- Win rate：絕對差值 `<= 0.01` percentage point。
- 三個 count metrics：exact match。

實作需保留 TradingView raw precision，最後才套用 tolerance，不可先按畫面格式 round 後再計算。若特定 currency 的最小單位不是 `0.01`，後續 LLD 應定義 currency-aware tolerance；未定義時不得擴大容忍值掩蓋 mismatch。

### Paired Desktop evidence

`trade_sample.csv` 沒有同一時間點的 Trading Report summary，只能驗證 CSV 欄位解析與 Open／Closed 分類，不能單獨作為 Report reconciliation ground truth。

2026-09-02 從同一個 Desktop Pane 取得 `TWSE_DLY:2344 / 1D` 的 Trading Report，並與 `data/trade_data_TWSE_2344.csv` 配對。CSV 顯示精度的計算結果為：

```json
{
  "closed_trade_net_profit": 869.12,
  "open_commission_charged": 3.52,
  "report_comparable_net_profit": 865.60,
  "report_total_net_profit": 865.59545,
  "win_rate_percent": 36.36363636363637,
  "total_trades": 11,
  "winning_trades": 4,
  "losing_trades": 7
}
```

Total net profit 差值為 `0.00455 TWD`，來自 Desktop CSV 顯示精度，落在 `0.01 TWD` tolerance 內。Sanitized paired fixture 位於 `tests/fixtures/strategy-trading/desktop-paired-report-trades.json`；此 evidence 不代表所有 Strategy、locale、currency 或 TradingView version 都具有相同 raw shape。

## Output contract

每個成功 Symbol 的正式輸出至少包含：

```text
<output-dir>/
└── <run-id>/
    ├── manifest.json
    └── symbols/
        └── <safe-symbol-name>/
            ├── report.json
            ├── trades.json | trades.jsonl | trades.csv
            └── reconciliation.json
```

- `report.json`：完整 canonical Strategy Report 與 snapshot metadata。
- `trades.json`／`trades.jsonl`／`trades.csv`：完整 Strategy Trading Data；default JSON，JSONL 適合 streaming，CSV 使用固定 canonical headers 並保留 Entry／Exit 雙列語意。
- `reconciliation.json`：Report 值、Trade-derived 值、差值、tolerance 與五項 match result。
- `manifest.json`：run context、Watchlist Snapshot、schema versions、每個 Symbol 狀態、artifact paths、errors 與 summary counts。

Output rules：

- 所有 artifacts 先寫入 run staging area。
- 單一 Symbol 只有在完整 Strategy Trading Data、snapshot stability 與五項 reconciliation 全部通過後才可 atomic publish。
- 失敗資料可保留為明確標記的 diagnostic artifact，但不可放在成功輸出路徑或標示為 complete。
- Symbol filename 必須經 deterministic safe-name encoding；manifest 保留原始 TradingView symbol。
- CSV 應明確定義 UTF-8、delimiter、quote、newline 與 null representation，避免 locale 影響。
- 大型資料不應預設完整塞入 MCP response；MCP 可回傳 metadata、artifact paths、summary 或單批資料。

## Error semantics

至少需要區分以下錯誤：

- Tab／Layout／Pane selector 無法解析或 ownership 改變。
- Strategy Instance 不存在、不是 Strategy、已被移除或無法成為 active。
- Symbol 不存在、不可用或切換 readback 不一致。
- Chart Symbol／Timeframe readback timeout。
- Strategy recalculation timeout 或 stale Report。
- Raw Trade schema unsupported／required field unavailable。
- Snapshot changed during retrieval。
- Pagination incomplete、duplicate 或 gap detected。
- Report metric unavailable。
- Reconciliation mismatch。
- Output staging／publish failed。

錯誤 response 必須包含 phase、Symbol、context、可安全揭露的 diagnostics 與 retryability。任何 inner operation 回傳 error 時，outer batch result 不可仍標示 `success: true`。

## Feature scope

本 feature 納入：

1. Watchlist Snapshot 與 sequential Symbol orchestration。
2. 明確的 Tab → Chart Target／Layout → Pane → Strategy context locking。
3. Symbol switching 與 Chart readiness readback。
4. Strategy recalculation freshness 與 snapshot identity。
5. Strategy Report canonical contract。
6. 對同一份 Strategy Report results 執行完整 Strategy Trading Data batching／pagination。
7. Desktop CSV semantic mapping 與 stable canonical schema。
8. 五項 Trading Report／Trading Data reconciliation。
9. 指定目錄、staging、atomic publish、manifest 與 per-Symbol artifacts。
10. CLI、MCP、Core 共用 schemas、errors 與 deterministic tests。
11. Safe live validation，包括 localized Desktop CSV sample 與 runtime raw payload discovery。
12. Canonical Strategy Trading Data model 與 JSON／JSONL／CSV streaming encoders。
13. Single-Symbol verified export、完整Trade batching、五項reconciliation與atomic run artifact tree。

## Deferred scope

以下先不納入第一版：

- 多 Symbol 平行下載；第一版依 Watchlist 順序 serial execution。
- Community Script Search／Add。
- 以 UI 自動點擊 TradingView Desktop「下載」按鈕作為主要資料來源。
- 將 TradingView 未暴露的 Equity Curve 以其他資料替代。
- 以 commission、run-up、drawdown 或逐筆 P&L 作為 reconciliation gate。
- 跨不同 currency 合併績效。
- 匯出 Symbol 的 OHLCV／Volume Market History Data；該能力屬於既有 `history` feature。
- 使用 Chart History Loader、`requestMoreData()` 或 `bar_index` 取得下一批 Strategy Trades。
- Broker Account 的真實委託、成交紀錄或持倉。
- 遠端儲存、排程服務或分散式 worker orchestration。

## Tasks

| Task | Deliverable | Depends on | Status |
| --- | --- | --- | --- |
| [`TASK-001`](./TASK-001-runtime-contract-discovery.md) | Runtime contract discovery 與 LLD gates 決策 | — | `done` |
| [`TASK-002`](./TASK-002-chart-session-context.md) | Chart Session context locking 與 strict readback | TASK-001 | `done` |
| [`TASK-003`](./TASK-003-strategy-runtime-snapshot.md) | Strategy Runtime raw adapter 與 snapshot lifecycle | TASK-001, TASK-002 | `done` |
| [`TASK-004`](./TASK-004-canonical-model-reconciliation.md) | Canonical model、identity 與 reconciliation | TASK-001, TASK-003 | `done` |
| [`TASK-005`](./TASK-005-trading-report-cli.md) | `strategy active`／`trading-report` CLI vertical slice | TASK-002, TASK-003, TASK-004 | `done` |
| [`TASK-006`](./TASK-006-trading-data-pagination-cli.md) | `trading-data` JSON pagination CLI vertical slice | TASK-002, TASK-003, TASK-004, TASK-005 | `done` |
| [`TASK-007`](./TASK-007-formats-artifact-transaction.md) | JSON／JSONL／CSV encoders 與 artifact transaction | TASK-004, TASK-006 | `done` |
| [`TASK-008`](./TASK-008-single-symbol-export.md) | Single-Symbol verified export | TASK-005, TASK-006, TASK-007 | `done` |
| [`TASK-009`](./TASK-009-watchlist-sequential-export.md) | Active Watchlist sequential export | TASK-008 | `todo` |
| [`TASK-010`](./TASK-010-mcp-compatibility.md) | MCP parity 與 legacy compatibility | TASK-005, TASK-006, TASK-009 | `todo` |
| [`TASK-011`](./TASK-011-regression-delivery-gate.md) | Regression、live evidence、docs 與 release gate | TASK-010 | `todo` |

Dependency flow：

```text
TASK-001 Runtime discovery
  └─ TASK-002 Chart Session
       └─ TASK-003 Strategy Runtime
            └─ TASK-004 Canonical model + reconciliation
                 └─ TASK-005 Trading Report CLI
                      └─ TASK-006 Trading Data pagination CLI
                           └─ TASK-007 Formats + artifact transaction
                                └─ TASK-008 Single-Symbol export
                                     └─ TASK-009 Watchlist export
                                          └─ TASK-010 MCP + compatibility
                                               └─ TASK-011 Delivery gate
```

表格中的 dependency metadata 是實際執行 gate；圖示呈現主要 critical path。部分基礎 Tasks 可在 dependency 滿足後並行，但不得略過 Task 文件列出的 prerequisites。

## Implementation prerequisites

下列 contract 由 TASK-001 透過受控 live discovery 固定，並回寫 LLD／fixtures。依賴這些 contract 的 implementation Task 不得先行猜測：

1. Live raw Strategy Trade payload 與 Desktop CSV 17 類語意的 mapping table。
2. Fresh calculation 的 observable signals、polling interval 與 timeout。
3. Snapshot identity／derived signature 欄位。
4. 同一份 `reportData().trades` results 的 pagination ordering、cursor／offset 與 stable trade identity。
5. CLI commands、selectors、output flags、fail-fast／continue policy 及 exit codes。
6. MCP tools 的同步／非同步邊界與大型輸出策略。
7. Manifest、Report、canonical Trade model、JSON／JSONL／CSV 與 Reconciliation 的 versioned schemas。
8. Retry、resume、staging cleanup 與 partial failure policy。
9. Currency-aware tolerance 是否需要於第一版支援。
10. 操作結束後是否恢復原始 Symbol／Timeframe。

## Acceptance criteria

- [ ] 使用者能指定 Tab／Layout／Pane、Strategy `entity_id`、Watchlist 與輸出目錄。
- [ ] Run 開始時固定 Watchlist Snapshot，並依其順序逐一處理所有 Symbols。
- [ ] 每個 Symbol 都在 readback 確認切換成功且 Strategy fresh calculation 完成後才開始讀取資料。
- [ ] Report 與所有 Trade batches 可證明屬於相同 snapshot。
- [ ] Strategy Trading Data 不受固定 5,000 筆 tail limit 截斷，且 incomplete result 不會回報成功。
- [ ] Trade batching 只切分同一份 Strategy Report results，不呼叫 Chart History Loader，也不把 `bar_index` 當成 Offset／Cursor。
- [ ] Default JSON 與 JSONL／CSV outputs 都由同一 canonical Trade model 產生，不經 file-to-file reparse conversion。
- [ ] CSV projection 覆蓋 Desktop sample 的資料語意；欄名不受 TradingView UI locale 影響。
- [ ] Unix timestamp 保留，並附帶對應 UTC ISO 8601 欄位。
- [ ] Reconciliation 只 gate 總損益、勝率、總交易次數、獲利次數與虧損次數。
- [ ] Open Trade 浮動損益不納入五項 metrics、已收 commission 正確調整總損益；breakeven 規則明確且有測試。
- [ ] 未通過 snapshot、completeness 或 reconciliation 的 Symbol 不會發布正式 artifacts。
- [ ] Manifest 能分辨每個 Symbol 的成功、失敗、錯誤 phase 與 artifact 狀態。
- [ ] CLI、MCP 與 Core 使用相同 canonical schemas 與 error semantics。
- [ ] Deterministic tests 與受控 live validation 都通過，且不依賴 UI download clicks。
- [ ] 文件與 response 明確表示 Strategy Trading Data 是 Broker Emulator 的回測交易結果，不是 OHLCV 或 Broker Account 實際成交。

## Feature completion rule

本文件的產品流程、CLI contract、資料核對原則、LLD 與 Tasks 已完成規劃。Feature 只有在 TASK-001～TASK-011 的 dependency、acceptance criteria、tests 與 completion record 全部完成後，才能將狀態改為 `done`；僅完成 Core、CLI 或單一 live smoke 都不代表整體 feature 完成。
