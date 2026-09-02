---
id: TASK-006
title: Trading Data pagination CLI vertical slice
status: done
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

- [x] Caller可從offset 0走到`has_more=false`而無重複或遺漏。
- [x] Intermediate batch不宣告整份data complete。
- [x] Snapshot change立即停止，不混合兩次計算。
- [x] `bar_index`與Chart History Loader不參與pagination。

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

Completed on 2026-09-02.

- Added `getStrategyTradingData()` application service，重用TASK-005的Chart Session、explicit Strategy validation、fresh Report wait與finally restore lifecycle。
- Added oldest-first `offset`／`limit` batches；default limit為500、maximum為5,000。Runtime先在TradingView page context內slice，再透過CDP傳回bounded batch。
- Offset大於0必須帶前一批`snapshot_id`。Report snapshot、batch before及batch after任一不一致都回傳`STALE_STRATEGY_SNAPSHOT`，不回傳可被誤拼接的資料。
- Added completeness gates：`firstTradeIndex === 0`、raw Trade count等於Closed + Open totals、offset boundary及expected contiguous batch size；retained tail或count mismatch回傳`TRADING_DATA_INCOMPLETE`。
- Added canonical JSON batch envelope，包含schema version、context、Strategy、requested／resolved Symbol、Timeframe、Currency、oldest-first ordering、pagination metadata、canonical Trades及snapshot metadata。`complete`只在offset 0的一次呼叫已包含完整結果時為true；多批呼叫以`has_more=false`表示已到snapshot結尾，完整aggregate由後續export負責。
- Added `strategy trading-data <entity-id> --symbol <exchange:symbol>` CLI，支援Timeframe、Offset、Limit、Snapshot ID、Tab／Layout／Pane selectors及timeout，且request validation發生於CDP discovery前。
- Added deterministic tests，涵蓋first／last／empty／one-shot batch、snapshot required／matched／stale、mid-batch change、retained tail、count mismatch、offset／limit boundaries、bounded page-context slicing及CLI help／validation。
- Live validation：從原本`TWSE_DLY:2486 / 1D`切換至`TPEX:4768 / 1D`，以first／middle／last batches走訪`report_index` 0～7，snapshot全程一致且Chart成功恢復。另一次Report重算使舊snapshot失效時，command正確回傳stale error並要求從offset 0重新開始，未混合兩次計算。
- `fnm exec --using=22 npm run test:unit`：342 passed，0 failed。
- `fnm exec --using=22 npm run test:cli`：23 passed，0 failed。
- `fnm exec --using=22 npm run lint`：0 errors，3 pre-existing warnings。
