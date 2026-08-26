---
id: TASK-009
title: Strategy Instance selection
status: done
phase: study-strategy-cli
depends_on:
  - TASK-006
  - TASK-008
blocks:
  - TASK-010
scope: active-pane
---

# TASK-009: Strategy Instance selection

## Goal

讓使用者以明確 Strategy Entity ID 選擇 Strategy Tester 的 Active Strategy，取代目前依 Report Ready 或第一筆結果猜測 Strategy 的行為。

## Requirements

### In scope

- `strategy select <entity_id>` CLI、MCP 與 shared Core。
- 取得目前 Active Strategy 的 read API。
- 驗證 Entity 位於 Active Pane 且 Type 為 Strategy。
- 必要時開啟 Strategy Tester，並明確處理 Hidden Strategy。
- 等待指定 Strategy Report Ready，驗證 Report 與 Entity 對應。
- `study list/get` 標示 `is_active_strategy`。

### Out of scope

- Report Metrics、Orders、Trades 或 Equity payload。
- 在多個 Pane 間隱式 Focus 未指定 Strategy。
- 把 Indicator Entity 當作 Strategy。

### Constraints and references

- [`Strategy-specific operations`](../../docs/study_strategy_cli_design.md#strategy-specific-operations)
- [`LLD shared runtime rules`](./LLD.md#shared-runtime-rules)
- Existing selection heuristic: `src/core/data.js`

## Design

Selection 先從 Active Pane snapshot 解析 Strategy，開啟 Tester 並執行最小必要 visibility/select action，然後以 bounded polling 驗證指定 Entity 的 Report Ready。任何 fallback 都必須回報，不再靜默取第一個 Strategy。

## Verification and Delivery

### Tests

- Single／multiple strategies、already active、hidden、indicator ID、unknown ID 與 report timeout tests。
- Strategy Tester closed/open behavior 與 `is_active_strategy` readback tests。
- CLI／MCP selection contract tests。

### Acceptance criteria

- [x] 多 Strategy Pane 可明確切換至指定 Entity。
- [x] Indicator、Unknown 或其他 Pane Entity 被拒絕。
- [x] Hidden Strategy 的 visibility change 會明確回報。
- [x] Selection success 只在指定 Strategy Report Ready 且 readback confirmed 後回傳。
- [x] `study list/get` 能辨識目前 Active Strategy。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run test:all
```

### Deliverables

- Strategy Select／Get Active Core、CLI、MCP、Tester readiness logic、tests 與 selection documentation。

## Completion record

- Completed: 2026-08-21.
- Implementation: `state`／`study list` resolve `is_active_strategy` from `activeStrategySource().value()` rather than report readiness; added `strategy active`／`select` CLI and matching MCP tools.
- Selection safety: validates Active Pane ownership and Strategy type, explicitly unhides only the requested Strategy, opens Strategy Tester, uses the exposed model adapter, and returns success only after the requested Entity is both Active and Report Ready.
- Automated validation: single／multiple／hidden Strategy, Indicator／unknown ID, unsupported adapter and selection readback tests pass. Live selection was not run because TradingView Desktop CDP port `9222` was unavailable.
