---
id: TASK-008
title: Single-Symbol Strategy Trading export
status: todo
phase: strategy-trading
depends_on:
  - TASK-005
  - TASK-006
  - TASK-007
blocks:
  - TASK-009
scope: active-pane
---

# TASK-008: Single-Symbol Strategy Trading export

## Goal

交付`strategy trading-export <entity-id> --symbol <symbol>`，在同一Symbol Session內取得Report A、完整Trading Data、Report B、完成五項reconciliation並atomic發布artifacts。

## Requirements

### In scope

- 建立`exportStrategySymbol()`唯一single-Symbol workflow。
- 新增`strategy trading-export --symbol`CLI surface。
- 迭代所有Trade batches並stream至selected encoder。
- Report A／batches／Report B snapshot一致性驗證。
- Streaming aggregates與pure reconciliation parity。
- 輸出report、trades、reconciliation與single-run manifest。
- Failure phase、diagnostics、cleanup與CLI exit behavior。

### Out of scope

- Watchlist iteration或parallel Symbols。
- MCP parity、OHLCV或Broker executions。

### Constraints and references

- [`Single-Symbol export flow`](./LLD.md#single-symbol-export)
- TASK-005～007 vertical slices。

## Design

Application Service只prepare一次Symbol Session。它不呼叫低階CLI subprocess，而是重用Report／batch Core functions。任何pagination、snapshot或reconciliation failure都abort transaction，不發布final Symbol directory。

## Verification and Delivery

### Tests

- Single／multi-batch happy paths與zero-trade strategy。
- Report A／B mismatch與mid-batch stale snapshot。
- Reconciliation pass／fail與Open／Breakeven cases。
- JSON／JSONL／CSV artifacts與manifest paths。
- Encoder／filesystem failure cleanup。
- CLI required args、summary與exit code。

### Acceptance criteria

- [ ] 一個command完成單一Symbol的Report與完整Trading Data匯出。
- [ ] 所有artifacts屬於同一snapshot。
- [ ] 五項metrics全部matched才publish成功。
- [ ] Failure不留下看似完整的final output。
- [ ] 三種Trading Data formats產生相同reconciliation結果。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run tv -- strategy trading-export --help
```

### Deliverables

- Single-Symbol application service、CLI、artifact set、tests與manual validation guide。

## Completion record

Not started.
