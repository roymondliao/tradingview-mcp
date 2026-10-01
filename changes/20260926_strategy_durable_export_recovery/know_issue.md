# Known Issues

## KI-001: Strategy Symbol export 的共用邊界與命名不夠明確

Status: `resolved`

### 原始問題

`strategy trading-export` 是 Strategy execution 中單一 Symbol Trading Report、Trading Data 與 Reconciliation 的原子匯出單位。TASK-003 已讓 legacy export 與 durable attempt 共用 `strategy-trading.js` 內相同的 runtime workflow，包括：

- Symbol／Timeframe 切換與 Strategy activation。
- Report A snapshot。
- 從 offset 0 開始分批取得完整 Trading Data。
- Report B snapshot。
- Snapshot validation 與 reconciliation。
- Report、Trades、Reconciliation artifact metadata 產生。

原本兩種執行模式的差異只在artifact lifecycle：

- Existing `strategy trading-export` 使用 `createArtifactSetTransaction()`，保留 schema V1 manifest 與整組 artifacts 的 publish／abort 行為。
- Durable `strategy run`／`strategy resume` 使用 `createStrategySymbolAttemptArtifactWriter()`，將同一份 runtime workflow 的輸出寫入 attempt-owned staging，成功後再 atomic commit 至正式 Symbol Directory。

雖然沒有重複實作runtime邏輯，共用workflow原本以`exportStrategySymbolIntoRun()`表示，durable caller則透過`exportStrategySymbol({ _run: { artifact_writer } })`注入writer。這組命名與`_run`private-shaped option造成以下誤解或維護風險：

1. 容易誤以為 durable Symbol attempt 沒有重用 `strategy trading-export` 的 codebase。
2. `exportStrategySymbolIntoRun()` 的名稱無法準確表達它其實是 standalone export 與 durable attempt 共用的 Symbol export workflow。
3. `_run.artifact_writer` 將 orchestration context 與 storage adapter 混在公開函式的 options 中，module boundary 不夠清楚。
4. 後續修改者可能在 standalone 或 durable path 另外加入 runtime logic，導致兩條路徑產生行為差異。

### Resolution

已在不改變artifact schema與runtime behavior的前提下，將共用層與三種lifecycle wrapper明確拆分：

```text
executeStrategySymbolExport()             # 唯一共用runtime workflow
├── exportStrategySymbol()                # standalone V1 transaction wrapper
├── exportStrategySnapshotIntoRun()       # Watchlist namespaced transaction wrapper
└── executeDurableStrategySymbolAttempt() # durable attempt writer／restore wrapper
```

目前責任邊界：

- `executeStrategySymbolExport()`只負責單一Symbol的TradingView interaction、Report／Data retrieval、snapshot validation、reconciliation，以及透過明確artifact writer interface寫入結果。它不接受transaction、namespace或`_run`options，也不擁有publication／attempt commit。
- `exportStrategySymbol()`只負責standalone command的V1 transaction、manifest、publication、abort及Chart Session lifecycle，再以transaction-backed writer呼叫共用workflow。
- `exportStrategySnapshotIntoRun()`負責Watchlist order、V1 incremental manifest、namespaced transaction writer、per-Symbol cleanup及final restore；每個Symbol直接呼叫同一共用workflow。
- `executeDurableStrategySymbolAttempt()`將attempt transaction轉成writer，呼叫同一共用workflow並負責per-attempt Chart restore；retry executor仍負責attempt staging commit／abort與artifact-v2 manifest transition。
- `strategy-resume.js`不再自行組裝writer／restore／`_run`options，只使用明確的durable wrapper。

共用writer interface維持最小化：

```text
openTrades()
writeReport(value)
writeReconciliation(value)
artifactInfo()
```

Production code與tests中已不存在`exportStrategySymbolIntoRun`或`_run`private option。

### 影響範圍

- 這是code organization、命名與介面清晰度修正，不是資料正確性或durability defect fix。
- Existing `strategy trading-export` schema V1、Active Watchlist V1與formal artifact V2輸出不變。
- 不變更retry policy、manifest state model、commit ordering或Resume semantics。
- Durable wrapper仍在attempt commit前完成Chart restore，行為與原路徑一致。
- Tests現在以`executeStrategySymbolExport`或`executeDurableStrategySymbolAttempt`明確注入，不再依賴private-shaped public options。

### Resolution criteria

- [x] Standalone、Watchlist與durable wrappers明確呼叫同一個具名Symbol export workflow。
- [x] Durable integration不再依賴`_run.artifact_writer`這類private-shaped option。
- [x] Report／Data／Reconciliation runtime logic只有`executeStrategySymbolExport()`一份實作。
- [x] Standalone V1 transaction、Watchlist V1 namespace及durable V2 attempt lifecycle各自由明確wrapper擁有。
- [x] Node 22／24 full regression與lint通過，並補入completion evidence。

### Completion evidence

- Targeted standalone／Watchlist／durable attempt／Run／Resume suites：47 tests passed。
- Node 22 full unit suite：642 tests passed，0 failed。
- Node 24 full unit suite：642 tests passed，0 failed。
- `npm run lint`：0 errors；僅保留`src/core/data.js`兩筆與`src/tools/watchlist.js`一筆既有unused-variable warnings。
- Production與tests全域搜尋確認沒有`exportStrategySymbolIntoRun`、`_run.transaction`或`_run.artifact_writer`殘留。
- `git diff --check`通過。

## KI-002: Watchlist structural validation 無法證明 TradingView Symbol 可解析

Status: `resolved`

Planned resolution: [`TASK-009`](./TASK-009-watchlist-symbol-validation.md)

### 現況

`captureNamedWatchlistSnapshot()`目前會驗證Named Watchlist：

- 每個值符合`EXCHANGE:TICKER`字串格式。
- 沒有duplicate Symbol identities。
- Account inventory declared count與detail returned count一致。
- 連續兩次Account detail reads具有相同ordered Symbols及metadata。

因此Snapshot中的`invalid_symbol_count: 0`只表示structural syntax有效，不代表TradingView Desktop能解析每個Symbol。Formal Strategy Run會在各Experiment實際切換Symbol時才發現runtime問題，同一個無效Symbol可能在多個Parameter Sets重複retry並延遲整個Run。

Chart readiness另有一個相關false-positive：現有`waitForChartReady()`會確認`chart.symbol()`與requested identity相符，並使用：

```js
document.querySelectorAll('[class*="bar"]')
```

估算bar count。該selector會匹配toolbar、sidebar及其他無關UI class，不能代表Main Series具有Trading Data。

### Reproduction evidence

2026-09-30使用frozen `dev-testing-list`中的index `103`、requested Symbol `TPEX:2640`完成controlled Desktop CDP復現；每次probe後均恢復原`TWSE_DLY:2478 / 1D`。

#### Non-existent `TPEX:2640`

- TradingView Desktop UI不允許User手動加入此商品。
- Frozen Account Watchlist Snapshot仍包含`TPEX:2640`。
- Public Symbol Search沒有`TPEX:2640` exact match。
- `chart.symbol()`仍回顯`TPEX:2640`，所以API echo不是存在性證據。
- `symbolExt.symbol`、`full_name`、`pro_name`、`exchange`、`description`及`type`全部為`null`。
- Main Series `bars().size()`為`0`。
- DOM文字明確包含`此商品不存在`。
- 寬泛`[class*="bar"]` selector同時回傳`138`個elements，直接證明current readiness heuristic會false positive。
- Strategy Report使用20秒及60秒timeout皆回傳`STRATEGY_CALCULATION_TIMEOUT`，而不是較早且準確的Symbol error。

#### Valid control `TPEX:6227`

- `chart.symbol()`為`TPEX:6227`。
- `symbolExt.full_name`與`pro_name`為`TPEX:6227`。
- `exchange: TPEX`、`description: Macnica Galaxy Inc.`、`type: stock`。
- Main Series `bars().size()`為`300`。
- Invalid-symbol UI為false。

#### Timing evidence

同一Desktop session、200ms polling量測：

- CDP connect：`88.9 ms`。
- `TPEX:2640`的metadata absent + invalid UI約`208.7 ms`成立。
- `TPEX:6227`的metadata約`202.1 ms`出現，bars約`609.7 ms`可用。
- 兩個Symbols加restore的probe round trip為`1,459.7 ms`。

切換後的第一個read可能保留上一個Symbol的bars或invalid UI：`TPEX:2640`在`7.7 ms`仍短暫看到positive bars，`TPEX:6227`在`1.2 ms`仍短暫看到前一個invalid UI。因此不能立即以一次empty metadata／zero bars判定不存在；必須在固定eventual window內等待positive metadata或明確invalid UI。

### Rejected validation paths

- `chart.symbol()`exact echo：不存在商品仍可能原樣回顯。
- `[class*="bar"]` DOM count：已證明會匹配無關UI elements。
- Main Series bars單獨判定：切換過渡期會看到stale positive或temporary zero。
- Public REST Symbol Search單獨判定：屬fuzzy public catalog，不代表登入Desktop／Pane的data resolver。
- `window.TradingViewApi.searchSymbols()`：以`TPEX:2640`、`2640`、有效的`TPEX:6227`及`6227`實測皆回傳空陣列；雖不切換Chart，但目前Desktop build不可用作resolver。
- `STRATEGY_CALCULATION_TIMEOUT`反向推測不存在：會混淆真正的慢速Strategy calculation與invalid Symbol，且發現時間過晚。

### Impact

- 無效Symbol會通過read-only Snapshot validation並被寫入frozen Watchlist SSOT。
- 同一Symbol可能在每個Experiment消耗完整retry budget。
- Current failed Run `obv-v3-20260929T135327Z-e92851c5`在三個Experiments都只有`TPEX:2640`失敗，總計1341/1344 succeeded。
- Baseline cumulative `attempt_count`達6，證明initial Run與首次Resume各取得3-attempt budget，但persistent invalid Symbol不會因Resume自行修復。
- Invalid attempt artifacts會正確cleanup，沒有data mixing；問題屬input validation、error taxonomy及長時間execution waste，不是durability corruption。
- Frozen Run不可移除`TPEX:2640`後繼續Resume；User只能修正Account Watchlist並建立新Run ID。

### Required behavior

由`watchlist` module在formal Run的Strategy sync／Experiment execution前執行TradingView Desktop CDP Symbol validation：

- Metadata canonical identity是primary validity signal。
- Main Series bars及invalid UI作diagnostics／not-found佐證。
- 每attempt固定1秒，每Symbol最多3 attempts，User不可設定。
- Explicit not found立即回報；1秒內indeterminate才retry。
- 單筆失敗不fail fast，繼續驗證完整Watchlist。
- 完成後以bounded per-Symbol errors通知User。
- 任一failed Symbol會阻止Strategy execution，不自動移除或忽略Watchlist內容。
- Dry-run維持read-only，明確標示CDP validation只在formal Run執行。
- Initial durable Run／Watchlist state必須在Chart mutation前落地；validation成功後才atomic更新為validated SSOT。
- Validation failure保存failed Run evidence；User修正Watchlist後必須使用新Run ID。

詳細state、retry、error、crash／Resume及compatibility contract見TASK-009。

### Resolution

TASK-009已於2026-09-30完成：

- Formal Run會先建立canonical Run Directory，保存`run.json`與含pending validation的frozen `watchlist.json`，再逐一以TradingView Desktop CDP驗證Symbol。
- Canonical metadata identity為primary valid signal；Main Series bars與invalid UI只作bounded diagnostics／not-found evidence。
- 固定每attempt 1秒、每Symbol最多3 attempts；not-found／exhausted不fail fast，但整批有任何錯誤就會在Strategy sync前停止。
- Validation結果只允許保持Snapshot ID、ordered fingerprint及Symbols不變的atomic `symbol_validation`replacement。
- Pending validation可由same-run Resume整批重驗；known failed Snapshot在runtime identity resolution及Strategy mutation前拒絕。
- Existing artifact-v2沒有`symbol_validation`時仍保持Resume相容。
- Controlled live mixed probe確認`TPEX:2640`於attempt 1回報`WATCHLIST_SYMBOL_NOT_FOUND`、`TPEX:6227`為valid，並成功還原`TWSE_DLY:2478 / 1D`。
- Node 22／24當時完整unit suites各652/652通過；exact-name`stock_all_list`後續以實際648/648 validation與single-baseline endurance完成TASK-007。

### Resolution criteria

- `TPEX:2640`在最多1個attempt內回報`WATCHLIST_SYMBOL_NOT_FOUND`，不再延後成`STRATEGY_CALCULATION_TIMEOUT`。
- `TPEX:6227`在1秒eventual window內由canonical metadata判定valid。
- Mixed Watchlist會完成全部entries並一次回報所有bounded errors。
- Invalid Watchlist不進入Strategy sync／Experiments，且Chart完成restore。
- Successful formal Run的`watchlist.json`保存與Snapshot ID／ordered fingerprint綁定的validation evidence。
- Existing artifact-v2 Resume保持相容；pending validation crash可same-run重驗，known invalid frozen Snapshot不可進入Strategy execution。
- `stock_all_list`已完成實際648/648 validation及TASK-007 single-baseline capacity gate。
