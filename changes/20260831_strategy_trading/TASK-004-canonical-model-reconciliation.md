---
id: TASK-004
title: Canonical Trading model and reconciliation
status: done
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
- 同一 Pane 的 Trading Report／Trading Data paired fixture；CSV 顯示精度與 Total Net Profit tolerance case。

### Acceptance criteria

- [x] 所有formats共用同一canonical model。
- [x] `bar_index`只保留metadata，不參與pagination identity。
- [x] Open Trade mark-to-market P&L 不進入五項 metrics；已收 commission 正確調整 Total Net Profit；Breakeven只計 total。
- [x] Snapshot schema version與signature deterministic。
- [x] Reconciliation mismatch提供逐metric evidence。

### Validation commands

```bash
npm run lint
npm run test:unit
```

### Deliverables

- Canonical schemas、normalizers、identity／snapshot helpers、reconciliation module與fixtures/tests。

## Completion record

Completed on 2026-09-02.

- Added `src/core/strategy-trading-model.js`，統一 compact／verbose Trading Report 與 paired Trade canonical models，保留 Unix milliseconds 並附 UTC ISO 8601、availability metadata、Open `mark`／Closed `exit` 語意。
- Added oldest-first sequence validation、Offset／`report_index` traversal、label-independent Trade identity，以及 versioned stable JSON SHA-256 snapshot identity／field-level comparison；`bar_index` 只作 identity metadata，不作 pagination cursor。
- Added `src/core/strategy-reconciliation.js`，以 exact decimal-string summation 計算五項 metrics，counts exact match、Net Profit／Win Rate 套用 tolerance，並提供逐 metric evidence。
- Live paired evidence confirmed TradingView Report Net Profit equals Closed Trade net P&L minus already-charged Open Trade commission；Open mark-to-market P&L 不納入。Open commission unavailable 時，Report-comparable Net Profit 回傳 unavailable。
- Added sanitized `TWSE_DLY:2344 / 1D` paired fixture：Report `865.59545 TWD`，CSV display-derived `865.60 TWD`，差值 `0.00455 TWD`；11 Closed Trades、4 wins、7 losses與 `36.363636%` 全部 match。
- Added 19 focused deterministic tests，涵蓋normalization、availability、Open／Closed／Breakeven、ordering／gap／duplicate、snapshot determinism、numeric tolerance與paired Desktop reconciliation。
- `fnm exec --using=22 npm run test:unit`：318 passed，0 failed。
- `fnm exec --using=22 npm run lint`：0 errors，3 pre-existing warnings。
