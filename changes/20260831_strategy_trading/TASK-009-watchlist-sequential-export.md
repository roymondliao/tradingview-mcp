---
id: TASK-009
title: Watchlist sequential Strategy Trading export
status: todo
phase: strategy-trading
depends_on:
  - TASK-008
blocks:
  - TASK-010
scope: active-pane
---

# TASK-009: Watchlist sequential Strategy Trading export

## Goal

擴充`strategy trading-export <entity-id> --watchlist active`，固定Active Watchlist Snapshot並依原順序sequential重用`exportStrategySymbol()`處理所有Symbols。

## Requirements

### In scope

- Active Watchlist Snapshot capture與normalization。
- `--symbol`／`--watchlist active`mutual exclusion。
- Sequential per-Symbol execution，禁止parallel chart mutation。
- Per-Symbol success／failure、phase、artifacts與diagnostics。
- Manifest incremental staging與final summary counts。
- Failure continue／fail-fast與final exit policy依TASK-001決策。
- Context／Strategy固定與外部interference detection。

### Out of scope

- Multiple Watchlists、arbitrary `--symbols`batch或parallel acceleration。
- Resume、scheduler、remote worker或remote storage，除非TASK-001明確納入第一版。
- 複製single-Symbol switch／read／reconcile logic。

### Constraints and references

- [`Watchlist export flow`](./LLD.md#watchlist-export)
- TASK-008 `exportStrategySymbol()`。

## Design

Orchestrator只建立Watchlist Snapshot、run transaction、sequential loop與manifest aggregation。每個Symbol必須呼叫同一single-Symbol function；UI Watchlist中途變更不改變本次工作集合。

## Verification and Delivery

### Tests

- Watchlist order、empty list與duplicate symbol policy。
- Second Symbol failure後continue／fail-fast behavior。
- UI Watchlist mutation不改變captured snapshot。
- User切Pane／remove Strategy時後續Symbols明確失敗。
- Manifest requested／succeeded／failed／skipped與CLI exit code。

### Acceptance criteria

- [ ] Watchlist run只在開始時capture一次symbols。
- [ ] Symbols永遠sequential且重用single-Symbol workflow。
- [ ] 每個Symbol都有terminal manifest state。
- [ ] 任一failure不會被outer result標為全成功。
- [ ] Final summary與exit code符合固定policy。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run tv -- watchlist get
npm run tv -- strategy trading-export --help
```

### Deliverables

- Watchlist orchestration、CLI mode、manifest aggregation、failure policy、tests與docs。

## Completion record

Not started.
