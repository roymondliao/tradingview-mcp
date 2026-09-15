---
id: TASK-002
title: Chart Session context and strict readback
status: done
phase: strategy-trading
depends_on:
  - TASK-001
blocks:
  - TASK-003
  - TASK-005
  - TASK-006
scope: active-pane
---

# TASK-002: Chart Session context and strict readback

## Goal

建立長流程可重用的 Chart Session，固定 Tab／Layout／Pane context，嚴格驗證 Symbol／Timeframe mutation，並在使用者或其他 operation 改變 context 時明確失敗。

## Requirements

### In scope

- 新增 shared Core structured errors。
- 建立 `chart-session.js` 與 process-local Chart mutation mutex。
- 擴充 Pane assert／activate context與 Chart Symbol／Timeframe strict readback。
- Session 每個 phase revalidate target、layout、pane、symbol與 timeframe。
- Timeout／context change回傳 stable code、phase與 safe metadata。
- Dependency injection與 deterministic multi-tab／multi-pane tests。

### Out of scope

- Strategy Report freshness、Trade pagination或 file output。
- 阻止使用者操作 Desktop UI；只能偵測 interference。
- 跨 process distributed lock。

### Constraints and references

- [`New chart-session module`](./LLD.md#new-srccorechart-sessionjs)
- Existing `src/core/pane.js`、`src/core/chart.js`、`src/cli/pane-context.js`

## Design

CLI 解析 selectors 後將 immutable resolved context 傳入 Core。Session 在每個 phase reacquire／assert指定 Pane；Symbol／Timeframe timeout必須 throw，不可回傳 `success: true` 搭配 `chart_ready: false`。

## Verification and Delivery

### Tests

- Explicit Tab／Layout／Pane resolution、focus與readback。
- User switches active Pane during operation。
- Target closed、Layout changed、Pane ownership changed。
- Symbol／Timeframe success、timeout與wrong-readback。
- Mutex serializes same-process mutations。

### Acceptance criteria

- [x] Long-running Core operation不依賴一次性的Active Pane focus。
- [x] Wrong context或readback不會回傳success。
- [x] Context errors包含stable code與phase。
- [x] 既有 Pane／Chart commands regression不受影響。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run tv -- pane list
npm run tv -- state
```

### Deliverables

- Shared errors、Chart Session、strict readback、Pane／Chart integration與tests。

## Completion record

Completed on 2026-09-01.

- Added `src/core/chart-session.js`：immutable resolved context、process-local async mutex、Symbol／Timeframe mutation及兩次 stable API readback、per-phase session assertion。
- Added `src/core/errors.js`：bounded safe context與stable `CoreOperationError` metadata；CLI JSON error保留 `code`、`phase`、`symbol`、`retryable`與safe context。
- Extended `src/core/pane.js`：以 `target_id` reacquire，驗證 URL／Layout／Pane ownership，並在使用者只切換active Pane時refocus原 Pane。Resolved後不把可變的Tab ordinal當identity。
- Extended Chart readiness：API Symbol／Resolution必須存在且匹配；timeout分別回傳 `SYMBOL_SWITCH_FAILED`／`TIMEFRAME_SWITCH_FAILED`，不再回傳false success。
- Added 12 deterministic tests，涵蓋approved Symbol alias、bounded errors、Pane refocus、closed target、Layout／Pane／Symbol interference、strict readback、phase revalidation與mutex serialization。
- Live validation在 Tab 0／Pane 0將 `TPEX:3324` 切至requested `TWSE:2344`，readback resolved為 `TWSE_DLY:2344`／`1D`；finally恢復原始 `TPEX:3324`／`1D`，後續 `pane list`與`state`皆確認原context。
- `fnm exec --using=22 npm run lint`：0 errors，3 pre-existing warnings。
- `fnm exec --using=22 npm run test:unit`：279 passed，0 failed。
- `fnm exec --using=22 npm run test:cli`：19 passed，0 failed。
