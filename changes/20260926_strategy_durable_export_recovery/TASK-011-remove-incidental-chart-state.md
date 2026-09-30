---
id: TASK-011
title: Remove Incidental Chart Symbol and Resolution State
status: done
phase: strategy-durable-export-recovery
depends_on:
  - TASK-006
  - TASK-009
  - TASK-010
blocks:
  - TASK-007-controlled-live-gate
  - feature-completion
scope: durable-worker-pane-context
---

# TASK-011: Remove Incidental Chart Symbol and Resolution State

## Goal

將durable `strategy run`／`strategy resume`視為持有Pane lease的worker workflow。Run開始前Chart剛好顯示的Symbol與resolution是隨機UI state，不屬於Run intent、identity、artifact evidence或public response，也不需要在invocation結束時特別還原。

每個Watchlist validation probe及Strategy Symbol attempt仍必須明確設定requested Symbol；Strategy execution仍必須明確使用`requested.backtest.timeframe`並驗證readback。移除的是pre-existing Chart state的capture／persistence／restore，不是per-Symbol execution validation。

## Problem

目前generic Chart Session context會把Pane當下的`symbol`／`resolution`帶入：

- `run.json.resolved.target`。
- `experiment.json.target`。
- Final Run／Resume response的`context`。
- Watchlist validation與Strategy Symbol execution的restore baseline。

這些值不代表Watchlist、Experiment或backtest intent；process crash時也無法依靠它們完成restore。TASK-010已將它們排除於identity equality，但只排除驗證仍會留下誤導性的artifact／response欄位及不必要的Chart mutations。

## Correct contract

### Durable target

Durable target只描述操作位置與stable selector：

- Layout name。
- Saved Layout identity。
- Pane index／Pane ID。
- 必要的bounded runtime binding audit，例如current target ID／tab index；這些不得成為stable identity。

不得保存：

- Pre-existing Chart Symbol。
- Pre-existing Chart resolution／timeframe。

### Execution input

- Frozen Symbols只來自`watchlist.json.symbols`及Experiment manifest `requested_symbols`。
- 當前執行項目只來自manifest Symbol index／status。
- Backtest timeframe只來自`run.json.requested.backtest.timeframe`。
- 每個attempt明確set requested Symbol／timeframe並strict readback，不繼承Pane先前狀態。

### Completion behavior

- Durable Run／Resume不保證結束後Chart回到invocation開始前的Symbol或resolution。
- Chart最後停留狀態不具contract意義，不寫入final response。
- Parameter Set Base Inputs restore仍是必要correctness guard，不受本Task影響。
- Run／Pane leases、Strategy identity、Watchlist SSOT及artifact atomicity維持不變。

## Required implementation

### Artifact／response

- 新建Run的`run.json.resolved.target`不寫入`symbol`／`resolution`。
- 新建`experiment.json.target`不寫入`symbol`／`resolution`。
- Final Run／Resume response的`context`不回傳`symbol`／`resolution`。
- Existing artifact-v2若含舊欄位仍可讀取與Resume；舊值只忽略，不要求migration或手動修改。
- Error中的per-Symbol `requested_symbol`／`resolved_symbol`維持，因它們是實際work item evidence，不是target context。

### Runtime

- Durable workflow使用不依賴pre-existing Symbol／resolution的Pane ownership guard。
- Watchlist validation不capture或restore原Chart Symbol／resolution；批次結束只確認stable target／Pane ownership。
- Durable Symbol attempt不restore pre-existing Chart Symbol／resolution；下一attempt總是明確設定自己的requested Symbol／backtest timeframe。
- Run／Resume finalization及signal handling不執行Chart Symbol／resolution restore。
- Generic Chart commands、standalone `strategy trading-report`及legacy `strategy trading-export`的既有restore behavior不在本Task範圍，除非共用API需新增明確durable worker mode。

### Documentation

- 更新LLD、DECISIONS及manual test，移除durable Run／Resume的Chart Symbol／timeframe restoration acceptance。
- 明確區分Base Inputs restore與不再提供的incidental Chart state restore。

## Tests

- 新建Run／Experiment artifacts不包含target Symbol／resolution。
- Final Run與Resume responses不包含context Symbol／resolution。
- Existing artifact-v2含舊欄位仍可Resume。
- Watchlist validation success／failure／abort不呼叫original Symbol／resolution restore。
- 每個Strategy attempt仍明確設定並read back requested Symbol及backtest timeframe。
- Resume從任意current Chart state開始，只執行non-succeeded Symbols。
- Symbol failure、signal與fatal error仍正確persist state、restore Base Inputs並release leases。
- Legacy commands的restore regression保持通過。
- Node 22／24完整unit、lint及`git diff --check`通過。

## Acceptance criteria

- [x] Durable artifacts不保存incidental target Symbol／resolution。
- [x] Final Run／Resume response context不暴露incidental Symbol／resolution。
- [x] Durable workflow不capture或restorepre-existing Chart Symbol／resolution。
- [x] Requested Symbol與backtest timeframe仍由每個work item明確設定及驗證。
- [x] Base Inputs restore、leases、stable identity及artifact safety不回歸。
- [x] Existing artifact-v2與legacy command相容性通過。
- [x] Automated regression完成；manual guide已改為worker Pane acceptance。

## Completion record

Completed on 2026-09-30.

- 新增durable worker target projection，正式Run／Resume的`run.json`、`experiment.json`與final response均不再保存`symbol`／`resolution`。
- Resume read-only discovery仍可讀取current Chart state，但execution context與artifact只保留Pane ownership／runtime binding；移除`chart_restore_baseline`。
- Watchlist validator保留generic restore default，durable caller明確使用`restore_chart: false`，因此validation success／failure／abort不還原Chart。
- Durable Symbol attempt使用worker mode：每次明確set及strict readback requested Symbol／backtest timeframe，成功或失敗後皆不還原pre-existing Chart state；legacy trading-report／trading-export維持原restore契約。
- Existing artifact-v2即使含舊`target.symbol`／`target.resolution`仍可由stable identity projection讀取及Resume。
- Base Inputs restore、Run／Pane leases、manifest commit與per-Symbol atomic artifacts維持不變。
- Targeted worker／legacy compatibility suites：67 tests passed。Node 22與Node 24完整unit suites各669/669 passed；lint為0 errors（保留3筆既有warnings），`git diff --check`通過。
