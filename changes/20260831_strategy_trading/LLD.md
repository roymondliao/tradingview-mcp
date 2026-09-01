# Strategy Trading Data LLD

Status: `draft-for-review`

## Purpose

本文件定義 [`Strategy Trading Data Workflow`](./README.md) 的 CLI-first implementation architecture。第一版以 CLI command contract 作為產品入口，將可重用行為實作於 Core modules；MCP tools 後續直接呼叫相同 Core application service，不建立另一套 workflow，也不透過 shell 或 CLI subprocess 串接功能。

本 LLD 不建立 implementation Tasks。待 architecture 與尚需 live discovery 的 TradingView runtime contract 確認後，才拆分 vertical-slice Tasks。

## Architecture principles

1. **CLI-first contract**：先固定 command、arguments、stdout、file output 與 exit semantics，再實作支援該 contract 的 Core modules。
2. **Core owns behavior**：Symbol switching、Strategy validation、fresh calculation、snapshot、pagination、reconciliation 與 output transaction 都在 Core 完成。
3. **No command composition**：`strategy trading-export` 重用 `trading-report`／`trading-data` 背後的 functions，不啟動兩個低階 CLI processes。
4. **Explicit resource identity**：所有 Strategy reads 都要求 `entity_id`、`symbol` 與明確 Pane context；沒有指定或找不到時回傳 error，不猜測第一個 Strategy。
5. **Context is revalidated**：一次 resolve Active Pane 不足以保護長流程；每個 mutation／read phase 都要確認 target、layout、pane、Strategy、symbol 與 timeframe。
6. **One report snapshot**：Report A、全部 Trade batches 與 Report B 必須屬於同一個 Strategy calculation snapshot。
7. **Trade batching is record batching**：只對 `reportData().trades` 使用 Offset／Limit；不呼叫 Chart History Loader、`requestMoreData()` 或使用 `bar_index` 作為 cursor。
8. **Canonical model before formats**：TradingView raw payload 先正規化為 canonical objects，再由 JSON／JSONL／CSV encoders 輸出；不以 JSON file 作為中間轉檔格式。
9. **Publish only verified artifacts**：未完成 pagination、snapshot validation 或 reconciliation 的資料只能留在 staging／diagnostic state，不可發布成成功結果。
10. **Deterministic seams**：TradingView runtime、clock、polling、filesystem 與 encoder 都必須可注入，CI 不依賴真實 TradingView Account。

## Target CLI contract

### Command inventory

| Command | Status | Responsibility |
| --- | --- | --- |
| `strategy active` | Extend existing | 讀取指定 Pane 當前 Active Strategy、Symbol、Timeframe、Report state 與可用的 snapshot metadata。 |
| `strategy trading-report <entity-id>` | New target name | 針對明確 Strategy 與 Symbol 等待 fresh calculation，回傳 canonical Trading Report。 |
| `strategy trading-data <entity-id>` | New target name | 針對明確 Strategy 與 Symbol，從同一份 `reportData().trades` 讀取一批 canonical Strategy Trades，或寫出指定格式。 |
| `strategy trading-export <entity-id>` | New | 對單一 Symbol 或 Active Watchlist 執行完整 Report、Trades、reconciliation 與 artifact transaction。 |

Target CLI 不包含 `strategy select`。每個需要 Strategy Data 的 command 都自行驗證 `entity_id` 是否存在於 resolved Pane、type 是否為 Strategy；runtime 可在內部將指定 Strategy 設為 Strategy Tester active source，但不將這個 implementation step 暴露成必須先執行的 public command。

既有 `strategy report`、`strategy trades` 與 `strategy select` 不作為新 workflow 的 dependency。它們的 deprecation／removal compatibility 需在 delivery task 中明確處理，不得讓新 commands 靜默繼承舊 tail-only 或 report-ready semantics。

### Shared context options

所有 Pane-scoped commands 沿用：

```text
--tab-index
--url-chart-id
--layout-id
--pane-index
```

Long-running command 不能只使用 CLI `withPaneContext()` 在開始前 focus 一次。CLI 先解析 selector，然後將 resolved immutable context 傳入 Core application service；Core 在各 phase 使用同一 context revalidate／reacquire Pane。

### `strategy active`

```bash
npm run tv -- strategy active \
  --layout-id <layout-id> \
  --pane-index <pane-index>
```

Response 至少包含：

```text
success
context
symbol
timeframe
strategy_count
active_strategy
report_state
snapshot_id?       # 只有能安全建立時提供
```

此 command read-only，不切換 Symbol、Timeframe、Strategy 或 visibility。

### `strategy trading-report`

```bash
npm run tv -- strategy trading-report <entity-id> \
  --symbol <exchange:symbol> \
  [--timeframe <resolution>] \
  [context options] \
  [--timeout <milliseconds>]
```

Contract：

- `entity-id` 與 `--symbol` 必填。
- `--timeframe` 未提供時固定 resolved Pane 當前 Timeframe，response 仍回傳實際值。
- Command 可切換指定 Pane 的 Symbol／Timeframe，等待相對應 Strategy calculation ready。
- Success 只在 readback 的 context、entity、symbol、timeframe 與 Report 全部一致時回傳。
- Response 包含 canonical Report、五項 reconciliation metrics、currency、calculation metadata 與 `snapshot_id`。
- 此 command 不取得完整 Trades，也不寫 Report file；正式檔案由 `trading-export` 管理。

### `strategy trading-data`

```bash
npm run tv -- strategy trading-data <entity-id> \
  --symbol <exchange:symbol> \
  [--timeframe <resolution>] \
  [--offset <integer>] \
  [--limit <integer>] \
  [--snapshot-id <id>] \
  [--format json|jsonl|csv] \
  [--output <file>] \
  [--force] \
  [context options]
```

Batch contract：

- Offset 以 canonical results 的 oldest-first ordering 計算，default `0`。
- Limit 是單次最多回傳的 paired Trades；實際 default／maximum 在 implementation task 固定，但 maximum 不得大於安全 CDP payload boundary。
- Offset `0` 可不提供 `snapshot_id`，response 建立並回傳 snapshot。
- Offset 大於 `0` 時必須提供前一批的 `snapshot_id`；不一致回傳 stale snapshot error。
- Response 包含 `total`、`offset`、`returned`、`next_offset`、`has_more`、`complete` 與 `snapshot_id`。
- `bar_index` 是 Entry／Exit metadata，不參與 Offset、ordering identity 或 next batch calculation。

Output contract：

- 未提供 `--output` 時，stdout 固定為 JSON batch envelope；`--format` 不改變 stdout transport。
- 提供 `--output` 時，檔案格式由 `--format` 決定；沒有 `--format` 時先由 `.json`／`.jsonl`／`.csv` 推導，無法推導則 default `json`。
- 明確 `--format` 與副檔名衝突時回傳 validation error。
- File output 完成後 stdout 只回傳 JSON summary，不重複輸出大型 Trades。
- Existing output 不覆寫，除非明確 `--force`。

`trading-data --output` 只處理該 invocation 的資料範圍；完整 Report／Trades／reconciliation artifact set 仍由 `trading-export` 提供。

### `strategy trading-export`

單一 Symbol：

```bash
npm run tv -- strategy trading-export <entity-id> \
  --symbol <exchange:symbol> \
  --output <directory> \
  [--timeframe <resolution>] \
  [--format json|jsonl|csv] \
  [context options]
```

Active Watchlist：

```bash
npm run tv -- strategy trading-export <entity-id> \
  --watchlist active \
  --output <directory> \
  [--timeframe <resolution>] \
  [--format json|jsonl|csv] \
  [context options]
```

Contract：

- `--symbol` 與 `--watchlist active` mutually exclusive，且必須提供其中一個。
- `--output` 必填；`--format` 只控制 Trading Data artifact，default `json` 或由明確 file configuration 推導。
- Report、Reconciliation 與 Manifest 固定 JSON。
- Watchlist mode 在 run start 建立 immutable Watchlist Snapshot，依原順序 sequential 執行 single-Symbol export function。
- 第一版不平行操作 Symbols。
- Watchlist mode 預設記錄單一 Symbol failure 並繼續下一個；run 完成後只要有 failure，CLI exit code 為非零。
- 每個成功 Symbol 必須通過 complete pagination、Report A/B snapshot stability 與五項 reconciliation。

## Dependency architecture

```text
src/cli/commands/strategy.js
  └── parse / validate CLI surface / JSON stdout
             │
             ▼
src/core/strategy-trading.js                 Application Service
  ├── chart-session.js                       Context + symbol session
  ├── watchlist.js                           Active Watchlist snapshot
  ├── strategy-runtime.js                    TradingView adapter
  ├── strategy-trading-model.js              Canonical data + identity
  ├── strategy-reconciliation.js             Pure five-metric comparison
  ├── strategy-trading-format.js             JSON / JSONL / CSV encoders
  ├── artifacts.js                           Staging + atomic publish
  └── errors.js                              Stable Core errors
             │
             ▼
connection.js / pane.js / chart.js / studies.js / time.js

src/tools/strategy.js
  └── same strategy-trading.js functions     MCP parity after CLI
```

Dependency rules：

- CLI 與 MCP 只能依賴 public Core functions，不可直接拼 TradingView page expressions。
- `strategy-trading.js` 不可 import CLI handlers 或 MCP schemas。
- `strategy-runtime.js` 不可寫檔或輸出 CSV／JSONL。
- `strategy-trading-format.js` 不可連接 CDP、切換 Symbol 或讀取 filesystem paths。
- `artifacts.js` 不理解 TradingView raw objects，只接收 encoder output 與 artifact metadata。
- Pure model／reconciliation tests 不建立 CDP connection。
- High-level export 不呼叫 `strategy report`／`strategy trading-data` CLI subprocess；它呼叫相同的 Core read functions。

## Module design

### Existing modules to reuse or extend

#### `src/connection.js`

Reuse：

- Explicit target reconnect。
- CDP timeouts 與 stage metadata。
- `evaluate()`／`callPageFunction()`。
- Safe input transfer。

不加入 Strategy business logic、snapshot 或 format conversion。

#### `src/core/pane.js`

Reuse `prepareContext()`、Pane inventory 與 focus readback。新增或抽出：

```js
assertPaneContext(expectedContext)
activatePaneContext(expectedContext)
```

`assertPaneContext()` 至少比對 `target_id`、`layout_id`、`pane_id`／`pane_index`；Symbol／Timeframe 由 Chart Session 另行比對。使用者切換其他 Tab 不必使 attached target 自動改變，但 target 消失、Layout 改變或 Pane ownership 改變必須失敗。

#### `src/core/chart.js`

Reuse Symbol／Timeframe mutation adapter，但建立 strict readback：

```js
setSymbolAndVerify({ symbol, context, timeout_ms })
setTimeframeAndVerify({ timeframe, context, timeout_ms })
```

Timeout 不得像現有 `waitForChartReady()` 一樣回傳 `false` 後仍標記 success。Readback 必須使用 TradingView Chart API 的 Symbol／Resolution，而非只依 localized DOM text。

#### `src/core/watchlist.js`

Reuse `getWatchlist()`。Application Service 在 run start 立即正規化並 deep-copy：

```js
{
  list_id,
  list_name,
  symbols: [{ symbol }],
  captured_at,
  captured_at_iso
}
```

後續 UI Watchlist 變更不影響當次 run。

#### `src/core/studies.js`

Reuse Active Pane Study classification、`entity_id` ownership、Strategy type 與 visibility readback。Trading commands 不依名稱選擇 Strategy。

#### `src/core/strategy.js`

保留既有 public atomic APIs 與 compatibility layer，但將重複的 Strategy source lookup、active-source adapter、raw Report read 與 Trade normalization逐步委派給新 modules。

`selectStrategy()` 的「找到 entity、必要時顯示、在 Strategy Tester 內設為 active source」保留為 internal runtime capability；新 CLI contract 不要求使用者先呼叫 `strategy select`。

#### `src/core/time.js`

所有 Unix timestamp 保留，並使用既有 helpers 建立 UTC ISO companion fields。`bar_index`、`report_index`、Offset 不產生 ISO 欄位。

### New `src/core/chart-session.js`

責任：在一個長流程中固定並保護 resolved Chart context。

建議 API：

```js
withChartSession({ context, _deps }, operation)
prepareSymbolSession({ context, symbol, timeframe, entity_id, timeout_ms, _deps })
assertSymbolSession(session, { phase, _deps })
```

`prepareSymbolSession()`：

1. Assert／reacquire expected Pane。
2. 驗證 `entity_id` 存在且為 Strategy。
3. Capture before calculation identity。
4. 切換 Symbol／Timeframe並 strict readback。
5. 再次驗證相同 `entity_id` 仍屬於該 Pane。
6. 交由 Strategy Runtime 等待 fresh／stable Report。
7. 回傳 immutable Symbol Session。

```js
{
  context,
  strategy: { entity_id, name },
  symbol,
  timeframe,
  before_snapshot_id,
  snapshot_id,
  started_at,
  started_at_iso
}
```

Session lock 只保證同一 process 內的 Core operations sequential。其他 CLI process 或使用者 UI 操作無法由 JavaScript mutex 阻止，因此每個 phase 仍必須 revalidate context／snapshot；偵測到 interference 時失敗，不靜默改用新 context。

### New `src/core/strategy-runtime.js`

責任：封裝 TradingView Desktop internal API，不暴露 unrestricted raw page objects。

建議 API：

```js
inspectStrategySource({ entity_id, _deps })
ensureStrategyActive({ entity_id, _deps })
readRawReportState({ entity_id, _deps })
readRawTradingReport({ entity_id, _deps })
readRawTradingDataBatch({ entity_id, offset, limit, _deps })
waitForFreshTradingReport({ entity_id, before, context, timeout_ms, _deps })
```

`readRawTradingDataBatch()` 必須在 page context 內先 slice，再經 CDP return-by-value 傳回，避免把一百萬筆 array 一次送入 Node：

```text
reportData().trades
  → validate total/order/snapshot inputs
  → slice(offset, offset + limit)
  → return only batch + identity fields
```

Runtime adapter 需要 live discovery 的項目：

- Regular／Deep Backtesting mode、testing range 與 generation metadata。
- `reportData().trades` raw ordering。
- Open Trade representation。
- Desktop CSV 17 類語意的 raw keys。
- Large trade retention／truncation signal。
- Report recalculating、ready、error 與 stable signals。

### New `src/core/strategy-trading-model.js`

責任：pure canonicalization、ordering 與 deterministic identity helpers。

建議 exports：

```js
normalizeTradingReport(raw, context)
normalizeStrategyTrade(raw, reportIndex)
normalizeStrategyTradeBatch(rawBatch)
classifyTradeStatus(trade)
createTradeIdentity(trade)
createSnapshotIdentity(snapshotFields)
compareSnapshotIdentity(expected, actual)
```

Canonical model 保留 paired Trade：

```js
{
  report_index,
  trade_number,
  status: 'closed' | 'open',
  entry: {
    id, label, direction, price,
    time, time_iso, bar_index, type
  },
  exit: {
    id, label, direction, price,
    time, time_iso, bar_index, type
  } | null,
  quantity,
  position_value,
  profit: { value, percent },
  cumulative_profit: { value, percent },
  run_up: { value, percent },
  drawdown: { value, percent },
  commission,
  duration_bars,
  currency
}
```

若 raw payload 未提供欄位，使用 `null` 與 availability metadata；不得以推測值填入。CSV flattening 不在此 module，避免 canonical paired model 被 file format 決定。

Snapshot identity 優先使用 TradingView generation ID；若沒有，使用 stable canonical JSON 產生 SHA-256 derived signature。Signature candidate fields：

```text
target_id / layout_id / pane_id
strategy entity_id
symbol / timeframe
backtest mode / test range
Strategy Inputs fingerprint
currency
raw trade total
closed / open counts
five reconciliation Report metrics
first / last stable Trade identity
```

Final fields 必須在 live discovery 後固定並加入 `snapshot_schema_version`；不可將 volatile UI text 或 localized labels 納入 signature。

### New `src/core/strategy-reconciliation.js`

責任：純函式計算並比對已核准的五項 metrics。

```js
calculateTradingDataMetrics(trades)
reconcileTradingReport({ reportMetrics, tradingDataMetrics, tolerance })
```

規則：

- 只使用 Closed Trades。
- Open Trades 不計入五項 metrics。
- Breakeven 計入 total，但不計入 winning／losing。
- Net Profit absolute tolerance default `0.01` currency unit。
- Win Rate absolute tolerance default `0.01` percentage point。
- Total／Winning／Losing counts exact match。
- 回傳每項 expected、actual、difference、tolerance、matched；所有 required metrics matched 才 `success: true`。

### New `src/core/strategy-trading-format.js`

責任：將 canonical Strategy Trading Data 編碼為 user-selected format。

```js
resolveTradingDataFormat({ format, output })
createTradingDataEncoder({ format, metadata, writable })
```

Encoder interface：

```js
encoder.start()
encoder.writeBatch(canonicalTrades)
encoder.finish()
encoder.abort(error)
```

Formats：

- `json`：default、lossless envelope；可用 streaming array writer，避免全部 Trades 常駐 memory。
- `jsonl`：第一行 `record_type: metadata`，後續每行一筆 `record_type: trade` paired Trade。
- `csv`：固定 UTF-8 與 canonical English headers；每筆 Trade 展開為 Exit／Entry rows，遵循 Desktop semantic mapping。

Format module 絕不從 JSON file 重新 parse 後轉檔；JSON 只是 default external format，canonical objects 才是唯一 conversion input。

### New `src/core/artifacts.js`

責任：可重用的 local artifact transaction，不包含 Strategy business rules。

建議 API：

```js
createArtifactTransaction({ output_directory, run_id, force, _deps })
transaction.openArtifact(relativePath, encoder)
transaction.writeJson(relativePath, value)
transaction.publishSymbol(symbolKey)
transaction.commitManifest(manifest)
transaction.abort(error)
```

Rules：

- Validate output target、safe relative paths 與 deterministic Symbol filename。
- Staging directory 必須位於 final output 同一 filesystem，確保 rename atomicity。
- Default 不覆寫 existing artifact。
- Symbol 只有在 pagination、snapshot 與 reconciliation 全部成功後 publish。
- Report、Reconciliation、Manifest 使用 UTF-8 JSON；Trading Data 使用 selected encoder。
- Partial file 不得使用 final filename。

### New `src/core/errors.js`

提供 CLI／MCP 共用的 structured Core error：

```js
new CoreOperationError(message, {
  code,
  phase,
  symbol,
  retryable,
  context,
  cause,
})
```

第一版至少包含：

```text
STRATEGY_ENTITY_REQUIRED
STRATEGY_NOT_FOUND_IN_PANE
ENTITY_NOT_STRATEGY
PANE_CONTEXT_CHANGED
SYMBOL_SWITCH_FAILED
STRATEGY_CALCULATION_TIMEOUT
STRATEGY_REPORT_UNAVAILABLE
STALE_STRATEGY_SNAPSHOT
TRADING_DATA_INCOMPLETE
TRADING_DATA_SCHEMA_UNSUPPORTED
RECONCILIATION_MISMATCH
OUTPUT_FORMAT_UNSUPPORTED
OUTPUT_FORMAT_EXTENSION_MISMATCH
OUTPUT_ALREADY_EXISTS
OUTPUT_WRITE_FAILED
```

CLI router 需保留 `code`、`phase` 與 safe metadata；MCP formatting 不改變 domain code。

### New `src/core/strategy-trading.js`

這是 CLI／MCP 共用的 Application Service facade。

Public API：

```js
getActiveTradingStrategy(options)
getStrategyTradingReport(options)
getStrategyTradingData(options)
exportStrategyTrading(options)
```

Internal reusable units：

```js
prepareStrategySymbol(options)
readTradingReportForSession(session)
readTradingDataBatchForSession(session, pagination)
exportStrategySymbol(options)
exportStrategyWatchlist(options)
```

`exportStrategyWatchlist()` 只負責建立 Watchlist Snapshot、sequential iteration、per-Symbol result aggregation 與 final manifest；每個 Symbol 必須呼叫同一個 `exportStrategySymbol()`，不得複製另一套 switch／wait／read／reconcile logic。

## Core execution flows

### Trading Report

```text
Resolve immutable Pane context
  → Prepare Symbol Session
  → Validate Strategy entity/type
  → Capture before Report state
  → Switch Symbol/Timeframe with strict readback
  → Ensure requested Strategy is internal active source
  → Wait for fresh and stable Report
  → Normalize Report
  → Create Snapshot Identity
  → Revalidate context
  → Return canonical Report
```

### Trading Data batch

```text
Resolve / prepare Symbol Session
  → Read current Snapshot Identity
  → Compare caller snapshot_id when provided
  → Slice reportData().trades in page context
  → Normalize one batch
  → Validate ordering and unique Trade identities
  → Re-read lightweight Snapshot Identity
  → Return batch envelope
```

### Single-Symbol export

```text
Prepare one Symbol Session
  → Report A
  → Open staging Trading Data encoder
  → offset=0
  → read / normalize / validate / write batch
  → repeat until has_more=false
  → finalize encoder
  → Report B
  → assert Snapshot A == all batches == Snapshot B
  → calculate five metrics from canonical Closed Trades
  → reconcile with Report B
  → write report.json + reconciliation.json
  → atomic publish Symbol artifacts
  → return Symbol summary
```

Reconciliation needs aggregate values but not necessarily all Trades in memory。Application Service 可在 streaming write 同時計算 count／sum，僅保存 Trade identities 或 bounded diagnostics；final totals 必須與 pure reconciliation module 使用相同 rules。

### Watchlist export

```text
Resolve context once
  → Capture immutable Watchlist Snapshot
  → Create run staging + manifest
  → for each Symbol sequentially
      → exportStrategySymbol(same context, same entity_id, symbol)
      → append success / failure to manifest
  → finalize counts
  → publish manifest
  → return JSON run summary
```

## Response contracts

### Trading Report envelope

```js
{
  success: true,
  schema_version,
  context,
  strategy: { entity_id, name },
  symbol,
  timeframe,
  currency,
  calculation: { mode, range, ready_at, ready_at_iso },
  snapshot_id,
  snapshot_schema_version,
  metrics,
  reconciliation_metrics: {
    total_net_profit,
    win_rate_percent,
    total_trades,
    winning_trades,
    losing_trades
  },
  availability
}
```

### Trading Data batch envelope

```js
{
  success: true,
  schema_version,
  context,
  strategy: { entity_id, name },
  symbol,
  timeframe,
  snapshot_id,
  total,
  offset,
  returned,
  next_offset,
  has_more,
  complete,
  trades
}
```

`complete` 只在 `offset === 0` 且該 response 已包含全部 results，或 aggregate export 已走到 `has_more === false` 時為 true。單一中間 batch 不可宣告整份 Trading Data complete。

## Output architecture

```text
<output-directory>/
└── <run-id>/
    ├── manifest.json
    └── symbols/
        └── <safe-symbol-name>/
            ├── report.json
            ├── trades.json | trades.jsonl | trades.csv
            └── reconciliation.json
```

Manifest 記錄：

```text
run_id / schema versions
resolved Tab/Layout/Pane context
Strategy entity/name and Inputs fingerprint
Watchlist Snapshot or requested single Symbol
Timeframe and requested format
per-Symbol state / snapshot / artifact paths / errors
requested / succeeded / failed / skipped
started_at / completed_at with ISO companions
```

## CLI and MCP ownership

### CLI

`src/cli/commands/strategy.js` 只負責：

- Command registration／help。
- parseArgs option definitions。
- Required／mutually-exclusive argument validation。
- 呼叫 Core application service。
- Output summary 交給既有 router 以 JSON 印出。
- 依 Core error 讓 router 產生 exit code。

大型 data file 由 Core artifact／encoder modules 寫入；CLI handler 不自行拼 CSV 或直接呼叫 `writeFileSync()`。

### MCP

`src/tools/strategy.js` 在 CLI behavior 穩定後增加對應 tools，直接呼叫相同 functions。MCP 大型資料預設回傳 batch或 artifact summary，不把完整 Watchlist Trade Data 放進 tool response。

MCP tool schema 可以使用 snake_case，但必須維持與 CLI 相同 required fields、defaults、format semantics、snapshot rules 與 Core errors。

## Concurrency and interference

- Watchlist Symbols 永遠 sequential。
- 同一 process 的 chart-mutating Strategy operations 使用 shared async mutex 包住完整 Symbol Session，不只包單次 `setSymbol()`。
- Mutex 不保護其他 CLI process，也不能阻止使用者在 Desktop 點擊 Pane／修改 Strategy。
- 每個 phase 使用 immutable expected context 與 snapshot revalidation 偵測外部 interference。
- External change 一律回傳 `PANE_CONTEXT_CHANGED` 或 `STALE_STRATEGY_SNAPSHOT`，不自動採用新 Pane／Strategy。
- Snapshot stale retry 必須重新執行整個 Symbol workflow；不可只重抓中間 batch 後拼接。

## Compatibility boundaries

- `strategy orders` 與 `ordersData()` 保持 raw Order semantics，不納入此次 Trading Data export。
- `history`、`bars_per_request`、`max_requests`、`max_bars` 與 OHLCV output 不受影響。
- `data strategy`／`data trades` legacy aliases 不擴充成新 contract；是否 deprecate 由 delivery task 記錄。
- `batch_run` 不新增 Strategy Trading action。
- `strategy report`／`strategy trades` 不可被新 export workflow 當作 subprocess dependency。
- Target public names 使用 `trading-report`、`trading-data` 與 `trading-export`。

## Testing architecture

### Pure unit tests

- Raw compact／verbose Trade normalization。
- Closed／Open／Breakeven classification。
- Stable Trade identity、oldest-first ordering 與 duplicate detection。
- Snapshot signature determinism／schema version／mismatch。
- Five reconciliation metrics與 tolerance boundaries。
- JSON／JSONL／CSV golden outputs、escaping、null、UTF-8 與 newline。
- Format inference與 extension conflict。
- Safe Symbol filename與 path traversal rejection。

### Runtime adapter tests

- Explicit entity lookup、wrong Pane、wrong type、hidden Strategy與 internal active-source behavior。
- Report recalculating → ready、old Report still readable、timeout與 error states。
- Page-context slice uses Offset／Limit before CDP return。
- Snapshot changes before／after a batch。
- Open Trade raw variants與 unavailable fields。

### Application service tests

- Single Symbol happy path。
- Context changed after Symbol switch。
- Multiple Strategies in one Pane only reads requested `entity_id`。
- Complete multi-batch aggregation without duplicate／gap。
- Report A／B mismatch aborts publish。
- Reconciliation mismatch aborts publish。
- Watchlist preserves captured order and continues after one failure。
- No final artifact exists after partial write／encoder failure。
- JSON／JSONL／CSV export produces same canonical metrics。

### CLI contract tests

- Help inventory and option names。
- Missing entity／symbol／output、mutually exclusive source options。
- `--format`／extension conflicts and `--force` behavior。
- JSON stdout summary and nonzero exit on any failed Watchlist Symbol。
- Pane context selectors forwarded exactly once as immutable Core input。
- Removed／deprecated command behavior documented and deterministic。

### Live validation

- Inspect actual `reportData().trades` fields without logging unrestricted private objects。
- Compare canonical CSV semantics against [`data/trade_sample.csv`](../../data/trade_sample.csv)。
- Validate two Strategies in one Pane using explicit `entity_id`。
- Switch at least two Watchlist Symbols sequentially and confirm fresh Report identity。
- Validate multi-batch result against TradingView Desktop downloaded Trade list。
- Confirm Report／Trading Data five-metric reconciliation。
- Confirm output staging cleanup／publish using a dedicated disposable directory。

Live validation 不進 CI；CI 必須完整覆蓋 deterministic seams，不能以 live-only limitation 取代 tests。

## Implementation order

LLD 核准後，Tasks 應依 dependency 拆分為：

```text
CLI contract + shared errors
  → Chart Session context/readback
  → Strategy Runtime raw discovery/read adapter
  → Canonical Model + Snapshot
  → Trading Report CLI vertical slice
  → Trading Data pagination CLI vertical slice
  → Reconciliation
  → Format Encoders + Artifact Transaction
  → Single-Symbol Trading Export
  → Watchlist Sequential Export
  → MCP parity
  → Regression / docs / safe live gate
```

每個可觀察功能 Task 必須包含 CLI、Core、tests 與 command documentation；MCP parity 可在 CLI contracts 穩定後獨立成 vertical slice，但不得重新實作 domain workflow。

## LLD review gates

拆分 Tasks 前仍需確認：

1. 舊 `strategy report`／`strategy trades`／`strategy select` commands 的 deprecation policy。
2. `trading-data` default／maximum Limit。
3. Same-Symbol invocation 如何判定 fresh versus stable current Report。
4. TradingView generation／Deep Backtesting metadata availability 與 derived snapshot fields。
5. Raw Trade ordering、Open Trade representation 與 Desktop CSV field mapping。
6. Watchlist failure default、CLI final exit code 與是否提供 `--fail-fast`。
7. Existing output、`--force`、staging diagnostic retention 與 cleanup policy。
8. JSONL metadata-first record contract 及 CSV null representation。
9. 第一版是否支援 Regular／Deep Backtesting mode selection，或只記錄目前 active calculation mode。
10. Strategy Trading export 完成後是否恢復執行前 Symbol／Timeframe。
