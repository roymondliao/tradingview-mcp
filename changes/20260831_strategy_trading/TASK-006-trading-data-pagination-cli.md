---
id: TASK-006
title: Trading Data pagination CLI vertical slice
status: todo
phase: strategy-trading
depends_on:
  - TASK-002
  - TASK-003
  - TASK-004
  - TASK-005
blocks:
  - TASK-007
  - TASK-008
  - TASK-010
scope: active-pane
---

# TASK-006: Trading Data pagination CLI vertical slice

## Goal

交付`strategy trading-data <entity-id> --symbol <symbol>`的JSON batch vertical slice，以Offset／Limit與Snapshot ID安全讀取同一份`reportData().trades`。

## Requirements

### In scope

- 新增`strategy trading-data`CLI command與Core function。
- Offset／Limit validation、oldest-first ordering與batch metadata。
- Offset大於0時驗證caller提供的Snapshot ID。
- 回傳total、returned、next_offset、has_more與complete。
- Batch前後revalidatecontext與snapshot。
- Duplicate／gap／retention truncation回傳明確incomplete error。
- JSON stdout、CLI tests與command docs。

### Out of scope

- JSONL／CSV file output；由TASK-007交付。
- 完整single-Symbol artifact set或Watchlist orchestration。
- Orders、OHLCV或Bar Index pagination。

### Constraints and references

- [`Trading Data CLI contract`](./LLD.md#strategy-trading-data)
- TASK-003 runtime slice與TASK-004 canonical identity。

## Design

每次read在page context內slice。Offset 0建立snapshot；後續offset必須帶expected snapshot。中途recalculation、context change或retention mismatch不回傳可拼接的success batch。

## Verification and Delivery

### Tests

- First／middle／last／empty batch與boundary validation。
- Snapshot required、match與stale cases。
- Oldest-first ordering、duplicate／gap與incomplete detection。
- Page-context slice evidence與bounded response。
- CLI JSON stdout、help與exit codes。

### Acceptance criteria

- [ ] Caller可從offset 0走到`has_more=false`而無重複或遺漏。
- [ ] Intermediate batch不宣告整份data complete。
- [ ] Snapshot change立即停止，不混合兩次計算。
- [ ] `bar_index`與Chart History Loader不參與pagination。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run tv -- strategy trading-data --help
```

### Deliverables

- Trading Data Core／CLI pagination slice、JSON contract、completeness checks、tests與docs。

## Completion record

Not started.
