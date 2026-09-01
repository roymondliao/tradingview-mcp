---
id: TASK-005
title: Trading Report CLI vertical slice
status: todo
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

- [ ] Command必須同時指定entity與symbol。
- [ ] Response包含context、strategy、symbol、timeframe、metrics與snapshot。
- [ ] 找不到entity／wrong type不修改其他Strategy。
- [ ] CLI不要求使用者先執行`strategy select`。

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

Not started.
