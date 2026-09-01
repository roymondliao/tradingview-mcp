---
id: TASK-003
title: Strategy Runtime and snapshot adapter
status: todo
phase: strategy-trading
depends_on:
  - TASK-001
  - TASK-002
blocks:
  - TASK-004
  - TASK-005
  - TASK-006
scope: active-pane
---

# TASK-003: Strategy Runtime and snapshot adapter

## Goal

建立明確 Strategy `entity_id` 的 TradingView runtime adapter，能安全啟用指定 Strategy source、等待 fresh Report、讀取 raw Report與 page-context Trade slice，並提供 snapshot 所需 identity fields。

## Requirements

### In scope

- 新增 `strategy-runtime.js`。
- 驗證 Entity ownership與Strategy type；必要時內部顯示並啟用指定 Strategy source。
- 實作 bounded fresh／stable Report polling與error states。
- 讀取 raw Trading Report與 `reportData().trades.slice(offset, offset + limit)`。
- 每次 read 同時回傳context、total、calculation與snapshot candidate fields。
- 將既有 `strategy.js` 重複 source lookup逐步委派至runtime adapter。

### Out of scope

- Public `strategy select` workflow。
- Canonical format、reconciliation或filesystem output。
- Chart History／OHLCV loading。

### Constraints and references

- [`Strategy Runtime module`](./LLD.md#new-srccorestrategy-runtimejs)
- TASK-001 raw contract與TASK-002 Chart Session。

## Design

所有 slice 在TradingView page context內完成，再只回傳bounded raw batch。Freshness比較switch前後 observable state；same-symbol read則要求context match與連續stable observations。找不到entity或wrong type在任何Report read前失敗。

## Verification and Delivery

### Tests

- Multiple Strategies、wrong entity、wrong type與hidden Strategy。
- Internal active-source activation與readback。
- Old Report仍可讀、recalculating→ready、timeout與runtime error。
- Offset／Limit在page expression內先slice。
- Snapshot fields在batch前後改變。

### Acceptance criteria

- [ ] Runtime永遠讀取caller指定的`entity_id`。
- [ ] Fresh success不只依賴`report_ready === true`。
- [ ] 大型raw Trade array不會整份跨CDP傳輸。
- [ ] Runtime adapter不包含CLI、MCP、format或filesystem logic。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run tv -- study list --type strategy
npm run tv -- strategy active
```

### Deliverables

- Strategy runtime adapter、freshness polling、bounded Report／Trade reads、legacy refactor seams與tests。

## Completion record

Not started.
