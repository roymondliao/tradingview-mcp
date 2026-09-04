# TradingView 策略自動化操作手冊

本手冊說明如何使用本專案的 CLI 或 MCP tools，完成以下工作流程：

1. 將使用者修改後的 Pine Script 策略送入 TradingView、編譯並儲存。
2. 讀取目前 TradingView watchlist，逐一切換商品並匯出策略交易清單。
3. 逐一取得每個商品的策略績效報告，並將結果保存到指定目錄。

## 1. 執行方式

本專案的 `tv` CLI 沒有安裝成 global command。請在專案根目錄執行，並使用：

```bash
npm run tv -- <command> [arguments]
```

例如：

```bash
npm run tv -- status
npm run tv -- watchlist get
npm run tv -- strategy active --layout-id <layout-id> --pane-index <pane-index>
```

一般互動操作可直接使用上述形式。若輸出需要交給 `jq`、redirect 到 JSON 檔案，或由 shell script 解析，應關閉 npm 的執行訊息：

```bash
npm_config_loglevel=silent npm run tv -- watchlist get
```

否則 npm 加在 JSON 前面的 package/script banner 會使 `jq` 無法解析，並污染輸出的 JSON 檔案。

## 2. 前置條件

開始前請確認：

- 已在專案根目錄執行 `npm install`。
- TradingView Desktop 已登入。
- TradingView Desktop 已開啟 remote debugging/CDP。
- 目前圖表可以正常載入商品。
- 系統已安裝 `jq`，以便在批次腳本中解析 JSON。
- 策略回測需要的歷史區間、週期及策略參數已設定完成。

檢查連線：

```bash
npm run tv -- status
```

若 TradingView 尚未以 CDP 模式啟動，可嘗試：

```bash
npm run tv -- launch
```

## 3. 修改、上傳與編譯策略

### 3.1 從本機 Pine Script 檔案載入

假設策略位於 `./strategy.pine`：

```bash
npm run tv -- pine set --file ./strategy.pine
npm run tv -- pine compile
npm run tv -- pine errors
npm run tv -- pine save
```

各指令用途：

| CLI 指令 | MCP tool | 用途 |
|---|---|---|
| `npm run tv -- pine set --file ./strategy.pine` | `pine_set_source` | 將原始碼寫入 Pine Editor |
| `npm run tv -- pine compile` | `pine_smart_compile` | 編譯並執行 Add to chart 或 Update on chart |
| `npm run tv -- pine errors` | `pine_get_errors` | 取得 Monaco 編輯器中的編譯錯誤 |
| `npm run tv -- pine console` | `pine_get_console` | 讀取編譯訊息及 `log.info()` 輸出 |
| `npm run tv -- pine save` | `pine_save` | 在 TradingView 中儲存目前腳本 |

這裡的「上傳」代表把原始碼送進 TradingView Pine Editor、編譯並加入目前圖表。本專案目前沒有自動 Publish 公開或私有 TradingView Script 的工具。

### 3.2 使用 MCP tools

依序呼叫：

1. `pine_set_source`，傳入完整的 `source`。
2. `pine_smart_compile`。
3. `pine_get_errors`，確認沒有編譯錯誤。
4. `pine_save`。

只有在編譯成功且策略已存在於目前圖表後，才應開始批次切換商品。

### 3.3 驗證 Pine Script 是否可以正常運作

「編譯成功」只代表語法及型別基本正確，不代表策略一定能在目標商品上產生合理交易。建議依序完成以下四層驗證。

#### 第一層：靜態分析

靜態分析不需要連接 TradingView：

```bash
npm run tv -- pine analyze --file ./strategy.pine
```

對應的 MCP tool 是 `pine_analyze`，可協助檢查部分常見問題，例如：

- Array 越界。
- 未確認 array 是否為空就呼叫 `array.first()` 或 `array.last()`。
- 不安全或錯誤的 loop 範圍。
- 不合理的隱式 bool 轉換。
- 使用 `strategy.entry()` 或 `strategy.close()`，但沒有正確的 `strategy()` 宣告。

靜態分析只能找出工具已知的問題，不能取代 TradingView 的正式編譯。

#### 第二層：TradingView server 編譯檢查

在不修改目前圖表的情況下，先使用 TradingView server API 編譯：

```bash
npm run tv -- pine check --file ./strategy.pine
```

對應的 MCP tool 是 `pine_check`。請確認結果沒有 compilation errors，再將策略載入 Pine Editor。

#### 第三層：在目前圖表實際編譯

```bash
npm run tv -- pine set --file ./strategy.pine
npm run tv -- pine compile
npm run tv -- pine errors
npm run tv -- pine console
npm run tv -- state
```

檢查項目：

- `pine compile` 是否成功執行 Add to chart 或 Update on chart。
- `pine errors` 是否沒有編譯錯誤。
- `pine console` 是否沒有 runtime error 或預期外的訊息。
- `state` 回傳的 studies 是否包含目標策略。
- `state` 中的 symbol 和 timeframe 是否是預期的測試條件。

對應的 MCP tools：

1. `pine_set_source`
2. `pine_smart_compile`
3. `pine_get_errors`
4. `pine_get_console`
5. `chart_get_state`

#### 第四層：Strategy Tester 功能驗證

策略存在於圖表後，先取得明確的 Pane 與 Strategy Instance：

```bash
npm run tv -- tab list
npm run tv -- study list --type strategy --layout-id <layout-id> --pane-index <pane-index>
npm run tv -- strategy active --layout-id <layout-id> --pane-index <pane-index>
```

記下目標 Strategy 的 `entity_id` 後，以明確的 Symbol 讀取 snapshot-complete Report 與 Trading Data：

```bash
npm run tv -- strategy trading-report <entity-id> \
  --symbol NASDAQ:AAPL --layout-id <layout-id> --pane-index <pane-index>
npm run tv -- strategy trading-data <entity-id> \
  --symbol NASDAQ:AAPL --layout-id <layout-id> --pane-index <pane-index>
```

至少檢查：

- `success`、`snapshot.available`與`report_ready`是否為`true`。
- `strategy.entity_id`、`requested_symbol`、`resolved_symbol`、timeframe及Pane context是否符合指定值。
- Report與Trading Data是否使用同一個`snapshot_id`。
- `metrics.total_trades`與Trading Data的`total`是否符合測試案例預期。
- Unix timestamps是否保留，且具有對應的`*_iso`欄位。
- 錯誤時process exit code與JSON中的`code`、`phase`、`retryable`是否合理。

若資料超過單批`limit`，後續批次必須傳入第一批的`snapshot_id`：

```bash
npm run tv -- strategy trading-data <entity-id> \
  --symbol NASDAQ:AAPL --offset 0 --limit 500
npm run tv -- strategy trading-data <entity-id> \
  --symbol NASDAQ:AAPL --offset 500 --limit 500 \
  --snapshot-id <snapshot-id-from-first-batch>
```

`total_trades == 0`不一定代表程式錯誤，也可能是日期範圍、商品、週期、進場條件或策略參數造成。Deprecated的`data strategy`、`data trades`、`strategy report`與`strategy trades`只保留 compatibility，不可用於完整匯出驗收。

#### 完整驗證順序

```bash
npm run tv -- pine analyze --file ./strategy.pine &&
npm run tv -- pine check --file ./strategy.pine &&
npm run tv -- pine set --file ./strategy.pine &&
npm run tv -- pine compile &&
npm run tv -- pine errors &&
npm run tv -- state &&
npm run tv -- strategy active --layout-id <layout-id> --pane-index <pane-index> &&
npm run tv -- strategy trading-report <entity-id> --symbol NASDAQ:AAPL \
  --layout-id <layout-id> --pane-index <pane-index>
```

建議的策略驗收標準：

1. 靜態分析沒有阻斷性問題。
2. TradingView server 編譯成功。
3. 策略可以加入或更新到目前圖表。
4. Pine Editor 沒有 compilation 或 runtime error。
5. Strategy Tester可以產生canonical Report與stable snapshot。
6. 在預先指定的商品、週期、日期範圍及參數下，完整交易數與五項reconciliation符合預期。
7. 至少使用一個正常案例及一個預期不產生交易的邊界案例測試。

## 4. 取得 watchlist

### 4.1 查看所有 watchlists

```bash
npm run tv -- watchlist list
```

### 4.2 取得目前啟用的 watchlist

```bash
npm run tv -- watchlist get
```

對應的 MCP tool 是 `watchlist_get`。主要回傳結構如下：

```json
{
  "success": true,
  "list_name": "My Watchlist",
  "symbols": [
    { "symbol": "NASDAQ:AAPL" },
    { "symbol": "NASDAQ:MSFT" }
  ]
}
```

後續 workflow 應使用 `symbols[].symbol` 的完整名稱，避免不同交易所之間出現同名商品。

## 5. 單一商品的回測資料

完整匯出使用單一高階CLI，Core會在固定的Tab／Layout／Pane內切換Symbol、等待重算、取得完整Trades、執行五項reconciliation，再恢復原始圖表：

```bash
npm run tv -- strategy trading-export <entity-id> \
  --symbol NASDAQ:AAPL \
  --timeframe 1D \
  --output ./output \
  --format json \
  --layout-id <layout-id> \
  --pane-index <pane-index>
```

`--format`支援`json`、`jsonl`與`csv`。成功後會建立獨立run目錄：

```text
output/<run-id>/
├── manifest.json
└── symbols/<safe-symbol>/
    ├── report.json
    ├── trades.json | trades.jsonl | trades.csv
    └── reconciliation.json
```

| CLI 指令 | MCP tool | 回傳內容 |
|---|---|---|
| `strategy active` | `strategy_get_active` | Active Strategy、Report狀態與safe snapshot metadata |
| `strategy trading-report` | `strategy_get_trading_report` | 指定Strategy／Symbol的canonical Report |
| `strategy trading-data` | `strategy_get_trading_data` | 同一snapshot的oldest-first Trade batch或單檔artifact |
| `strategy trading-export` | `strategy_export_trading` | 已驗證的Report、完整Trading Data、reconciliation與manifest |

正式artifacts只會在snapshot completeness與reconciliation都通過後atomic publish。既有run目錄或單檔預設不覆寫；需要明確使用`--force`。

## 6. Watchlist 批次匯出手冊

使用同一個`trading-export`command，將scope改為Active Watchlist：

```bash
npm run tv -- strategy trading-export <entity-id> \
  --watchlist active \
  --timeframe 1D \
  --output ./output \
  --format json \
  --layout-id <layout-id> \
  --pane-index <pane-index>
```

執行開始時會固定不可變的Active Watchlist Snapshot，再按原順序sequential處理。預設單一Symbol失敗後繼續；若要在第一個失敗停止，加入`--fail-fast`：

```bash
npm run tv -- strategy trading-export <entity-id> \
  --watchlist active --output ./output --fail-fast
```

`manifest.json`記錄每個Symbol的`succeeded`、`failed`或`skipped`、錯誤phase、artifact paths與summary。若部分失敗，已驗證成功的Symbol仍會發布，run狀態為`partial`且CLI exit code為`1`；CDP discovery failure使用exit code`2`。

不要在shell中自行平行呼叫多個Symbol commands；所有Symbol共用固定的Chart Session，並由Core負責一次性restore。

## 7. MCP 自動化流程

MCP是相同Core services的另一個transport，不另建一套domain workflow。CLI與MCP mapping如下：

| CLI | MCP |
|---|---|
| `strategy active` | `strategy_get_active` |
| `strategy trading-report` | `strategy_get_trading_report` |
| `strategy trading-data` | `strategy_get_trading_data` |
| `strategy trading-export` | `strategy_export_trading` |

`strategy_get_trading_data`未指定`output`時回一個bounded batch；指定本機`output`時可寫入JSON／JSONL／CSV並只回summary。`strategy_export_trading`接受`output_directory`，可直接建立與CLI相同的atomic artifact tree。

`strategy_select`、`strategy_get_report`、`strategy_get_trades`、`data_get_strategy_results`與`data_get_trades`是deprecated compatibility tools，其中Report／Trades結果明確不是snapshot-complete，不可用來宣稱完整匯出成功。

## 8. 已知限制與注意事項

### 8.1 Bounded response與完整匯出

`strategy trading-data`使用`offset`、`limit`與`snapshot_id`分批讀取同一份Strategy Report results；public limit上限為5,000，這是單批大小，不是完整交易數上限。只有`has_more == false`且snapshot始終一致時才走訪完結果。

需要完整資料時優先使用`strategy trading-export`；它會在Core內走訪全部batches，避免把大型Trades array塞入stdout或MCP response。Deprecated的`data_get_trades`與`strategy_get_trades`仍是tail-only compatibility surface。

### 8.2 Strategy Tester 的計算時機

TradingView必須先完成新商品載入與策略重算，Report才有效。新workflow會驗證Symbol／timeframe readback、active Strategy、fresh/stable Report與snapshot；不要使用多個平行worker操作同一張圖表。

### 8.3 錯誤回傳

除了process exit code，也要檢查JSON中的：

- `success`
- `code`與`phase`
- `retryable`
- `error`
- `snapshot_id`
- `summary`與每個`symbols[].status`
- `chart_restore`

`STALE_STRATEGY_SNAPSHOT`表示計算結果在批次之間改變，資料不可拼接；caller應從offset 0重新開始，而不是略過錯誤。

### 8.4 Tab、Layout與Pane

自動化開始前，應確認 MCP/CLI 連接到使用者正在看的 TradingView Desktop 分頁：

```bash
npm run tv -- tab list
npm run tv -- pane list
npm run tv -- state
```

`tab list`會同時提供`url_chart_id`、runtime`layout_id`、account`saved_layout_id`、layout name與Pane inventory。後續Strategy commands應固定其中一組唯一selector，再指定`pane_index`，不可假設第一個Tab或Pane就是目標。

若需要先切換已儲存的layout：

```bash
npm run tv -- layout list
npm run tv -- layout switch "Layout 名稱"
```

切換layout後應再次執行`study list --type strategy`與`strategy active`，確認目標`entity_id`存在於指定Pane。

## 9. 建議的後續功能

目前已具備單一Symbol與Active Watchlist的完整sequential export、manifest、五項reconciliation、atomic publish及JSON／JSONL／CSV。後續可獨立規劃：

- Resume既有partial run。
- 有限次數的retry policy與backoff。
- 明確的Deep Backtesting mode控制。
- Remote storage或async job queue。
- 不共享同一Chart Session時的安全平行化。
