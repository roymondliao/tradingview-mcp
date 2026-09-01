---
id: TASK-004
title: Canonical Trading model and reconciliation
status: todo
phase: strategy-trading
depends_on:
  - TASK-001
  - TASK-003
blocks:
  - TASK-005
  - TASK-006
  - TASK-007
scope: local
---

# TASK-004: Canonical Trading model and reconciliation

## Goal

建立format-neutral的Strategy Trading Report／Trade canonical model、stable Trade／Snapshot identity，以及五項closed-trade reconciliation純函式。

## Requirements

### In scope

- 新增 `strategy-trading-model.js`與`strategy-reconciliation.js`。
- Normalization涵蓋Desktop CSV語意、Unix／ISO時間與availability metadata。
- 定義oldest-first ordering、Trade identity、duplicate／gap detection。
- 建立versioned snapshot signature與expected／actual compare。
- 計算總損益、勝率、總交易數、獲利數與虧損數。
- 定義Open／Closed／Breakeven規則與numeric tolerance。

### Out of scope

- CDP mutation／polling、CLI routing或file encoding。
- 將unavailable raw fields臆造成數值。
- 以其他performance metrics作為success gate。

### Constraints and references

- [`Canonical model`](./LLD.md#new-srccorestrategy-trading-modeljs)
- [`Reconciliation module`](./LLD.md#new-srccorestrategy-reconciliationjs)
- TASK-001 mapping與TASK-003 raw adapter contract。

## Design

Canonical model保留paired Entry／Exit，不受CSV row shape決定。Snapshot使用TradingView generation ID或versioned derived SHA-256 signature。Reconciliation只接受canonical data，不讀TradingView或filesystem。

## Verification and Delivery

### Tests

- Compact／verbose／missing raw fields normalization。
- Oldest-first order、identity、duplicate與gap cases。
- Snapshot deterministic與mismatch cases。
- Open／Closed／Breakeven與zero-trade cases。
- Five metrics、rounding與tolerance boundaries。
- `trade_sample.csv` expected 1408.20／60%／5／3／2 fixture。

### Acceptance criteria

- [ ] 所有formats共用同一canonical model。
- [ ] `bar_index`只保留metadata，不參與pagination identity。
- [ ] Open Trade不進入五項metrics；Breakeven只計total。
- [ ] Snapshot schema version與signature deterministic。
- [ ] Reconciliation mismatch提供逐metric evidence。

### Validation commands

```bash
npm run lint
npm run test:unit
```

### Deliverables

- Canonical schemas、normalizers、identity／snapshot helpers、reconciliation module與fixtures/tests。

## Completion record

Not started.
