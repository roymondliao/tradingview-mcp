---
id: TASK-005
title: Trading Report CLI vertical slice
status: done
phase: strategy-trading
depends_on:
  - TASK-002
  - TASK-003
  - TASK-004
blocks:
  - TASK-006
  - TASK-008
  - TASK-010
scope: active-pane
---

# TASK-005: Trading Report CLI vertical slice

## Goal

交付CLI-first的`strategy active`擴充與`strategy trading-report <entity-id> --symbol <symbol>`完整vertical slice，讓使用者能取得明確Strategy／Symbol的fresh canonical Trading Report。

## Requirements

### In scope

- 擴充`strategy active`的context、Report state與safe snapshot metadata。
- 新增`strategy trading-report`CLI command、options與help。
- Entity／Symbol required validation與Pane selectors。
- Symbol／Timeframe switch、fresh Report wait、canonical response與stable errors。
- Legacy`strategy report`／`strategy select`CLI compatibility依TASK-001決策處理。
- Core application service functions、CLI contract tests與command docs。

### Out of scope

- Trade pagination、file output、Watchlist或MCP parity。
- Public Strategy select prerequisite。

### Constraints and references

- [`Trading Report CLI contract`](./LLD.md#strategy-trading-report)
- TASK-002～004 contracts。

## Design

CLI handler只解析options並呼叫`getStrategyTradingReport()`。Core建立Symbol Session、驗證entity、等待fresh／stable Report、normalizes並回傳Snapshot；沒有entity時直接error，不fallback。

## Verification and Delivery

### Tests

- CLI help、required args、context forwarding與exit codes。
- Multiple Strategies只讀指定entity。
- Symbol／Timeframe switch與same-symbol stable read。
- Fresh timeout、wrong context與Report unavailable。
- Active command read-only regression。

### Acceptance criteria

- [x] Command必須同時指定entity與symbol。
- [x] Response包含context、strategy、symbol、timeframe、metrics與snapshot。
- [x] 找不到entity／wrong type不修改其他Strategy。
- [x] CLI不要求使用者先執行`strategy select`。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run tv -- strategy --help
npm run tv -- strategy active
```

### Deliverables

- Trading Report Core／CLI vertical slice、active expansion、compatibility behavior、tests與docs。

## Completion record

Completed on 2026-09-02.

- Added `src/core/strategy-trading.js` application service，依序完成 explicit Strategy ownership/type validation、internal active-source readiness、before snapshot、strict Symbol／Timeframe Session、fresh stable Report、canonical normalization與public SHA-256 snapshot。
- Added `strategy trading-report <entity-id> --symbol <exchange:symbol>`，支援Timeframe、Tab／Layout／Pane selectors與per-phase timeout；missing／invalid Entity、Symbol及timeout在CDP discovery前回傳stable structured error。
- Expanded `strategy active`，read-only回傳Report state、calculation range、five reconciliation metrics與safe snapshot metadata；不切換Symbol、Timeframe、Strategy或visibility。
- Added Chart restore lifecycle：成功或calculation／snapshot失敗都在`finally`恢復原Symbol／Timeframe；Symbol Session strict readback中途失敗也會立即rollback，restore failure以`CHART_RESTORE_FAILED`明確失敗。
- Legacy `strategy select`／`strategy report`／`strategy trades`維持deprecated compatibility surface；new workflow不呼叫這些commands或legacy Core functions。
- Added deterministic Core／CLI tests，涵蓋required options、explicit Entity、same-Symbol stable read、Symbol mutation、snapshot unavailable、calculation failure、restore／rollback與active read-only expansion。
- Live validation：read-only active state成功；same-Symbol Report stable；由原本`TPEX:4768 / 1D`切換至`TWSE_DLY:2344 / 1D`取得fresh canonical Report與snapshot，並在command完成後成功恢復及readback原Chart。
- `fnm exec --using=22 npm run test:unit`：331 passed，0 failed。
- `fnm exec --using=22 npm run test:cli`：21 passed，0 failed。
- `fnm exec --using=22 npm run lint`：0 errors，3 pre-existing warnings。
