---
id: TASK-003
title: Strategy Runtime and snapshot adapter
status: done
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

- [x] Runtime永遠讀取caller指定的`entity_id`。
- [x] Fresh success不只依賴`report_ready === true`。
- [x] 大型raw Trade array不會整份跨CDP傳輸。
- [x] Runtime adapter不包含CLI、MCP、format或filesystem logic。

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

Completed on 2026-09-01.

- Added `src/core/strategy-runtime.js`，提供explicit entity ownership/type inspection、hidden Strategy visibility、active-source activation與readback。
- Added bounded Report state／Report reads、page-context Trade Offset／Limit slice，以及batch before／after snapshot candidates；完整`report.trades`不跨CDP傳輸。
- Added Strategy Inputs page-side SHA-256 fingerprint、calculation-mode availability、testing ranges、five metrics與first／last Trade identity；stable canonical JSON產生runtime SHA-256 signature。
- Implemented freshness lifecycle：same-context要求`200 ms`間隔連續3次stable；mutation後另要求calculating／unavailable transition或signature change；unknown status、old Report與timeout不fallback。
- Calculation phase在開始及成功完成時revalidate Chart Session；polling期間仍逐次驗證exact active source，但不重複target reconnect。
- Existing deprecated `strategy select`委派active-source能力給runtime adapter，同時保留report-ready compatibility contract。
- Added 12 deterministic tests，涵蓋multiple／missing／wrong-type／hidden Strategies、activation、bounded Report、stable/fresh lifecycle、runtime error、timeout、page-context slice與snapshot change。
- Live read-only validation在明確Tab／Pane及active Strategy上完成3次stable Report read，並確認bounded Trade batch的before／after runtime signatures相同；沒有切換Symbol或修改Strategy inputs。
- `fnm exec --using=22 npm run lint`：0 errors，3 pre-existing warnings。
- `fnm exec --using=22 npm run test:unit`：293 passed，0 failed。
- `fnm exec --using=22 npm run test:cli`：19 passed，0 failed。
