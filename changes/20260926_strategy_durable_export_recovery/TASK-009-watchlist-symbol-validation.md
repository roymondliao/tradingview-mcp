---
id: TASK-009
title: TradingView Watchlist Symbol Resolvability Validation
status: done
phase: strategy-durable-export-recovery
depends_on:
  - TASK-002
  - TASK-006
blocks:
  - TASK-007-live-capacity-gate
  - feature-completion
scope: watchlist-symbol-validation
---

# TASK-009: TradingView Watchlist Symbol Resolvability Validation

## Goal

在formal `strategy run`讓Named Watchlist Snapshot成為Experiments可消費的validated SSOT之前，由`watchlist` module透過目標TradingView Desktop CDP Pane逐一驗證每個Symbol可被TradingView解析。每個Symbol使用固定1秒eventual判斷與最多3個attempts；單筆失敗仍繼續驗證下一筆，完成全部掃描後以bounded errors通知User，並阻止含錯誤Symbol的Watchlist進入Strategy execution。

為維持D-001「mutation前先建立durable Run state」，formal Run仍先建立canonical Run Directory，寫入initial `run.json`與含`symbol_validation.performed: false`的frozen `watchlist.json`，再執行會切換Chart的validation。只有validation success被atomic persist後，該Watchlist才可供Strategy sync／Experiments使用。

此Task只驗證TradingView是否可解析Symbol identity。Strategy calculation、Trading Report、Trades及reconciliation仍由既有Strategy execution負責。

## Validated issue evidence

2026-09-30在TradingView Desktop `dev` Layout／Pane 0以CDP實測：

### Non-existent control: `TPEX:2640`

- Frozen `dev-testing-list` Snapshot確實包含此Symbol，index `103`。
- TradingView Symbol Search沒有`TPEX:2640` exact result。
- `chart.symbol()`仍回顯`TPEX:2640`，因此API symbol echo不能單獨證明存在。
- `symbolExt()`的`symbol`、`full_name`、`pro_name`、`exchange`、`description`與`type`全部為`null`。
- Main Series bars為`0`。
- DOM文字明確出現`此商品不存在`。
- 現有`document.querySelectorAll('[class*="bar"]')`仍得到`138`，證明寬泛DOM class count是false-positive readiness signal。
- Strategy Report在20秒及60秒timeout皆回傳`STRATEGY_CALCULATION_TIMEOUT`。

### Valid control: `TPEX:6227`

- `chart.symbol()`為`TPEX:6227`。
- `symbolExt()`提供`full_name: TPEX:6227`、`pro_name: TPEX:6227`、`exchange: TPEX`、`description: Macnica Galaxy Inc.`及`type: stock`。
- Main Series bars為`300`。
- Invalid-symbol UI為false。

### Measured timing

使用200ms polling的單次量測：

- CDP connect：`88.9 ms`。
- `TPEX:2640`：metadata absent + invalid UI約`208.7 ms`成立；原雙stable-readprobe約`409.9 ms`完成分類。
- `TPEX:6227`：metadata約`202.1 ms`出現；bars約`609.7 ms`可用；原雙stable-readprobe約`815.4 ms`完成分類。
- 兩個Symbols加restore的probe round trip為`1,459.7 ms`。
- 每次probe都恢復原`TWSE_DLY:2478 / 1D`。

結論：metadata identity是主要存在性訊號；Main Series bars與invalid UI提供diagnostics／佐證。取消連續兩次stable-read要求，但切換後不能立即用一次空metadata判定不存在；必須在固定1秒eventual window內等待positive metadata或明確invalid UI。

### Rejected read-only resolver

TradingView page內建`window.TradingViewApi.searchSymbols()`已在相同Desktop session實測：

- Query `TPEX:2640`與`2640`皆回傳空陣列。
- Query有效的`TPEX:6227`與`6227`同樣回傳空陣列。
- 呼叫前後Chart Symbol都保持`TWSE_DLY:2478`，確認它雖然read-only，但在目前Desktop build不可作為resolvability gate。

Public REST Symbol Search對`TPEX:2640`沒有exact match，可作manual supporting evidence；但它是fuzzy public catalog，不是目前登入Desktop／Pane data resolver，因此不作formal gate authority。

## Existing gap

目前`captureNamedWatchlistSnapshot()`只驗證：

- `EXCHANGE:TICKER`字串格式。
- Duplicate identities。
- Declared／returned／unique counts。
- 兩次Account detail reads穩定。

因此`invalid_symbol_count: 0`只表示structural syntax有效，不代表TradingView Desktop能解析Symbol。此欄位維持既有語意，不得重新解釋為CDP resolvability結果。

現有`waitForChartReady()`以API symbol echo及`[class*="bar"]` DOM count判定ready，無法偵測本次issue；TASK-009 validation不得沿用該DOM count作為存在性證據。

## Confirmed validation contract

### Fixed constants

Validation policy固定在codebase，不提供Run Config、CLI或environment overrides：

```text
WATCHLIST_SYMBOL_VALIDATION_ATTEMPT_TIMEOUT_MS = 1000
WATCHLIST_SYMBOL_VALIDATION_MAX_ATTEMPTS = 3
WATCHLIST_SYMBOL_VALIDATION_POLL_MS = 200
```

`MAX_ATTEMPTS = 3`表示每個Symbol最多總共3個attempts，不是initial加3次retry。

### One-attempt flow

每個attempt：

1. 呼叫`chart.setSymbol(requestedSymbol)`。
2. Poll直到`chart.symbol()`切換為requested canonical identity或1秒deadline。
3. 在同一次CDP page snapshot讀取：
   - `chart.symbol()`。
   - `chart.symbolExt()`的identity metadata。
   - Main Series `bars().size()`。
   - Localized invalid-symbol UI indicator。
4. 依下列規則完成或等待。

### Valid

下列條件成立即完成，不要求第二次相同read：

- API symbol已切換到requested canonical identity。
- `symbolExt.full_name`或`symbolExt.pro_name`存在。
- Metadata canonical identity與requested Symbol相符，允許既有verified aliases，例如`TWSE`對`TWSE_DLY`。

`description`與`type`保留為diagnostics，但不是valid必要條件，避免特殊商品缺少非identity metadata時被誤判。

### Not found

下列條件同時成立即回報明確不存在，不retry：

- API symbol已回顯requested identity。
- `full_name`與`pro_name`皆不存在。
- Invalid-symbol UI明確出現，例如`商品不存在`、`無效的商品`、`invalid symbol`或`symbol not found`。

Main Series `bar_count === 0`是佐證與diagnostic，不是唯一判定條件。不得因bars暫時為0直接宣告not found。

### Indeterminate and retry

1秒內沒有得到`valid`或`not_found`即為本attempt indeterminate：

- 重新呼叫`setSymbol()`開始下一attempt。
- 最多3 attempts。
- Retry decision由watchlist module內部固定流程控制，不依賴artifact中的`retryable`boolean。
- AbortSignal、CDP disconnect、Pane identity drift及restore failure沿用既有fatal guards，不被降級為一般Symbol timeout。

3 attempts後仍indeterminate，回報`WATCHLIST_SYMBOL_VALIDATION_TIMEOUT`，並繼續下一個Symbol。

## Error contract

### Per-Symbol errors

明確不存在：

```json
{
  "index": 103,
  "symbol": "TPEX:2640",
  "code": "WATCHLIST_SYMBOL_NOT_FOUND",
  "phase": "watchlist_symbol_validation",
  "attempt_count": 1,
  "message": "TradingView reports that TPEX:2640 does not exist."
}
```

3 attempts無法判定：

```json
{
  "index": 103,
  "symbol": "TPEX:2640",
  "code": "WATCHLIST_SYMBOL_VALIDATION_TIMEOUT",
  "phase": "watchlist_symbol_validation",
  "attempt_count": 3,
  "message": "TradingView could not resolve Symbol metadata within 3 attempts."
}
```

Messages、Symbol strings與diagnostics必須有固定長度上限。不得輸出body text、完整metadata object或unbounded event history。

### Aggregate result

Validator完成全部Symbols後回傳：

```json
{
  "success": false,
  "snapshot_id": "sha256:...",
  "ordered_symbol_fingerprint": "sha256:...",
  "timeframe": "1D",
  "requested": 448,
  "valid": 447,
  "failed": 1,
  "errors": [
    {
      "index": 103,
      "symbol": "TPEX:2640",
      "code": "WATCHLIST_SYMBOL_NOT_FOUND",
      "phase": "watchlist_symbol_validation",
      "attempt_count": 1,
      "message": "TradingView reports that TPEX:2640 does not exist."
    }
  ]
}
```

- 單筆validation error不fail fast；必須繼續下一Symbol。
- Error list只包含failed Symbols，不回傳完整valid Symbol list。
- Error entry shape固定且每欄bounded；Watchlist provider的最大容量仍須受既有Snapshot／artifact size guards限制。
- Aggregate `failed > 0`時formal Run回傳top-level `WATCHLIST_SYMBOL_VALIDATION_FAILED`，並包含上述summary。

## Formal Run integration

執行順序固定為：

```text
read-only dry-run preflight
  → acquire Run／Pane leases
  → recheck Pane ownership
  → create canonical Run Directory
  → write initial run.json and frozen watchlist.json with validation pending
  → validate frozen Watchlist Symbols through CDP
  → restore original Chart Symbol／Timeframe
  → atomically persist validation result in watchlist.json
  → validation success only: Strategy sync／Parameter Sets／Symbols
```

### Validation failure

若任何Symbol validation失敗：

- 仍先完成整份Watchlist掃描。
- Restore原Chart Symbol／Timeframe。
- Atomically更新`watchlist.json.symbol_validation`，保存failed summary與bounded errors。
- 將`run.json`轉為`failed`，error code為`WATCHLIST_SYMBOL_VALIDATION_FAILED`。
- 不執行Strategy sync、Parameter mutation或Experiment export。
- 不自動移除、改名或忽略Watchlist中的Symbol。
- User修正Account Named Watchlist後，必須重新capture Snapshot並使用新的Run ID執行。

Run Directory保留為validation failure evidence；它不是成功的execution SSOT，不可手動修改Symbols後Resume成另一個Snapshot。

### Successful SSOT evidence

Initial `watchlist.json`先保存完整frozen Snapshot與pending evidence：

```json
{
  "symbol_validation": {
    "schema_version": 1,
    "performed": false,
    "reason": "pending"
  }
}
```

全部Symbols valid後，以same-filesystem atomic replacement更新為bounded success summary：

```json
{
  "symbol_validation": {
    "schema_version": 1,
    "performed": true,
    "success": true,
    "source": "tradingview_desktop_cdp",
    "timeframe": "1D",
    "requested": 448,
    "valid": 448,
    "failed": 0,
    "max_attempts": 3,
    "attempt_timeout_ms": 1000,
    "validated_at": 1790000000000,
    "validated_at_iso": "2026-09-29T00:00:00.000Z"
  }
}
```

- Validation summary與同一Snapshot ID／ordered fingerprint共同構成SSOT evidence。
- 不在`watchlist.json`重複保存per-Symbol success records；完整ordered Symbols已存在。
- Existing artifact-v2 Runs沒有此optional summary時仍可Resume；不得因TASK-009 retroactively使已建立的Run無效。
- TASK-009完成後的新formal Runs必須先通過validation才可進入Strategy sync與Experiment execution。

### Crash／Resume behavior

- Process在validation完成前crash時，`watchlist.json.symbol_validation.performed`保留`false`；same-run Resume重新驗證整份frozen Snapshot，不根據Chart或folder狀態猜測部分進度。
- Validation完成且success後的Resume信任與Snapshot ID／fingerprint綁定的persisted evidence，不重跑完整Watchlist validation。
- Validation已完成且failed的Run，`strategy resume`回傳`WATCHLIST_SYMBOL_VALIDATION_FAILED`且不進行Strategy mutation；User必須修正Account Watchlist並建立新Run ID。
- Existing pre-TASK-009 artifact-v2 Run沒有`symbol_validation`時維持既有Resume相容行為，不retroactively要求驗證。

## Dry-run behavior

`strategy run --dry-run`維持read-only，不切換Chart，也不假裝完成CDP validation。Bounded response新增：

```json
{
  "symbol_validation": {
    "performed": false,
    "reason": "formal_run_only"
  }
}
```

Structural Snapshot validation仍在dry-run完成。User不能把dry-run的`invalid_symbol_count: 0`解讀為resolvability success。

## Module ownership

### `src/core/watchlist.js`

- 保留`captureNamedWatchlistSnapshot()`為read-only structural capture。
- 新增pure classification與CDP-backed validation service，例如：

```js
validateNamedWatchlistSymbols({
  snapshot,
  context,
  timeframe,
  signal,
  _deps,
})
```

- 由watchlist module擁有固定attempt constants、bounded result與per-Symbol error taxonomy。
- Reuse既有`symbolIdentitiesMatch()`canonical alias semantics。

### Chart／Pane dependencies

- 使用Run／Pane lease與pinned immutable Pane context。
- 一個validation invocation只取得一次Chart Session ownership。
- 依Watchlist order sequential validation；不可在同一Pane parallel `setSymbol()`。
- 整批完成或abort後restore一次原Symbol／Timeframe並strict readback。
- `CHART_RESTORE_FAILED`保持fatal，不得被包裝成普通Symbol validation error。

### `src/core/strategy-run.js`

- Formal Run在leases／Pane recheck及initial durable artifacts落地後、Strategy sync前呼叫validator。
- Validation failure持久化watchlist／Run failure evidence並回傳bounded response，phase為`watchlist_symbol_validation`。
- Dry-run只標示validation未執行。
- Collision、source、Strategy、Parameter Set及Snapshot preflight guards維持不變。

### `src/core/strategy-run-artifacts.js`

- Initial `writeInitialWatchlist()`維持exclusive create。
- 新增validated Watchlist atomic replacement，且必須驗證Snapshot ID、ordered fingerprint及ordered Symbols與initial artifact完全相同；只允許更新`symbol_validation`。
- Validation replacement failure保留previous durable Watchlist state並使Run失敗。

## Performance expectations

- Metadata positive或explicit invalid UI通常約200ms可判定。
- 每個attempt硬上限1秒；每個Symbol最多3秒。
- 448 Symbols典型預估約2～4分鐘；全數走3-attempt timeout的理論上限約22.4分鐘。
- 652 Symbols典型預估約3～6分鐘；全數走3-attempt timeout的理論上限約32.6分鐘。
- Metadata、Main Series bars及invalid UI必須在同一次page snapshot取得，不能拆成三個CDP round trips。
- 不為速度省略Pane ownership、restore或identity guards。

## Tests

### Pure classification

- Valid metadata canonical exact match。
- Verified alias match，例如`TWSE:2330`對`TWSE_DLY:2330`。
- API symbol echo但metadata空、invalid UI true → not found。
- Metadata空但invalid UI false → indeterminate，不可誤判不存在。
- Metadata存在但description／type缺漏 → identity仍可valid。
- Bars為0／stale positive只作diagnostics，不改變metadata-based existence classification。
- Wrong metadata identity不得valid。

### Retry executor

- Attempt 1／2／3 valid success。
- Explicit not found立即結束、不retry。
- 1秒indeterminate最多3 attempts後timeout。
- Exhausted Symbol記錄error後繼續下一Symbol。
- AbortSignal取消polling／retry。
- CDP、Pane drift及restore errors保持fatal。

### Formal Run integration

- Validation在leases、Pane recheck及initial durable artifact persistence後、Strategy sync前執行。
- 任一failed Symbol時保留failed Run evidence，但不執行Strategy mutation。
- 完成全部Symbols後一次回報所有bounded errors。
- 全部valid才寫入含`symbol_validation`summary的`watchlist.json`。
- Dry-run不呼叫validator並明確回報`formal_run_only`。
- Existing artifact-v2 Resume不要求retroactive validation summary。
- Crash留下`performed: false`時same-run Resume重新驗證完整frozen Snapshot；known failed validation不允許Resume進入Strategy execution。
- Run ID collision仍在任何Strategy mutation前拒絕。

### Controlled live

- `TPEX:2640`穩定回報`WATCHLIST_SYMBOL_NOT_FOUND`，不再延後為`STRATEGY_CALCULATION_TIMEOUT`。
- `TPEX:6227`在1秒eventual window內valid。
- Mixed small Watchlist完成全部entries並只回報invalid Symbol。
- 原Chart Symbol／Timeframe在success、validation failure、signal與exception後都恢復。
- 修正Named Watchlist並建立新Run後，validated Snapshot才能成為SSOT。
- `stock_all_list`通過652/652 Symbol validation後，才執行TASK-007 single-baseline capacity Run。

## Acceptance criteria

- [x] Structural Snapshot validation與CDP Symbol validation語意分離。
- [x] Metadata canonical identity是primary validity signal；bars／invalid UI依本Task規則作diagnostics或not-found佐證。
- [x] 每attempt固定1秒、每Symbol最多3 attempts且User不可設定。
- [x] Explicit not found立即回報；indeterminate才retry。
- [x] Exhausted／not-found Symbol不fail fast，完整Watchlist仍繼續驗證。
- [x] Initial Run／Watchlist artifacts在CDP validation mutation前durably落地。
- [x] 任一validation error會保存failed evidence並阻止validated SSOT與Strategy mutation。
- [x] 全部valid後`watchlist.json`以atomic replacement保存bounded validation evidence。
- [x] Dry-run保持read-only並標明CDP validation未執行。
- [x] Existing artifact-v2 Resume相容，不要求舊Run補寫validation evidence。
- [x] Crash期間的pending validation可same-run重驗；known failed validation不會進入Strategy execution。
- [x] TPEX:2640 negative及TPEX:6227 positive controlled live cases通過。
- [x] Node 22／24 targeted與full unit suites、lint及`git diff --check`通過。
- [x] TASK-007 `stock_all_list` 652-Symbol capacity gate只在652/652 validation通過後執行。

## Completion record

Completed on 2026-09-30.

- `watchlist` module新增固定1秒／最多3 attempts的CDP Symbol validator；canonical metadata identity為valid authority，Main Series bars及invalid UI只保留為bounded diagnostics／not-found evidence。
- Formal Run在leases、Pane recheck與initial durable artifacts落地後執行完整frozen Watchlist validation；failed result atomic寫入`watchlist.json`並於Strategy sync前停止。
- `watchlist.json.symbol_validation`為optional artifact-v2 extension。新Run先寫pending，再只允許保持Snapshot identity不變的completed atomic replacement；舊artifact-v2仍可Resume。
- Pending validation的same-run Resume會重新驗證整份Snapshot；known failed validation在任何runtime identity resolution或Strategy mutation前拒絕。
- Dry-run response明確回傳`performed: false`／`formal_run_only`，不切換Chart。
- Targeted suites共61 tests passed；Node 22與Node 24完整unit suites各652/652 passed。Lint為0 errors（保留3筆既有warnings），`git diff --check`通過。
- Controlled Desktop CDP mixed probe：`TPEX:2640`於attempt 1回報`WATCHLIST_SYMBOL_NOT_FOUND`，diagnostics為metadata absent、bars 0、invalid UI true；`TPEX:6227`判定valid。Probe後readback確認`dev`／Pane 0已還原`TWSE_DLY:2478 / 1D`。
- Exact-name`stock_all_list` 652/652 validation及single-baseline endurance Run仍屬TASK-007 live capacity gate，未在本Task宣稱完成。
