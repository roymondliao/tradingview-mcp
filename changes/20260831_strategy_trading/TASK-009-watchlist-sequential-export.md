---
id: TASK-009
title: Watchlist sequential Strategy Trading export
status: done
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

- [x] Watchlist run只在開始時capture一次symbols。
- [x] Symbols永遠sequential且重用single-Symbol workflow。
- [x] 每個Symbol都有terminal manifest state。
- [x] 任一failure不會被outer result標為全成功。
- [x] Final summary與exit code符合固定policy。

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

Completed on 2026-09-03.

- Added `strategy trading-export <entity-id> --watchlist active`，與`--symbol`互斥；支援default continue-on-error及`--fail-fast`。
- Active Watchlist只capture一次並建立immutable、ordered snapshot；執行期間UI清單變更不會改變本次工作集合。
- Watchlist逐一呼叫同一`exportStrategySymbol()` workflow，共用單一Chart mutex與run artifact transaction；整批結束只restore原始Symbol／Timeframe一次。
- Stable duplicate policy為first occurrence wins；後續同Symbol項目以`duplicate_symbol`終態記為skipped。
- Manifest在staging中incremental atomic replace，保存每個項目的succeeded／failed／skipped、phase、bounded error、artifacts及requested／succeeded／failed／skipped counts。
- Failed Symbol staging subtree會移除；成功與partial run完成restore後才atomic publish。Partial CLI result exit `1`，CDP partial failure exit `2`。
- Added deterministic tests涵蓋order、empty、duplicate、UI mutation、continue、fail-fast、partial cleanup、Strategy inputs interference、single restore、restore failure及exit mapping。
- Live Desktop 3.4.0以Layout `LC43xk9j`／Pane 0、Strategy `Jb3plx`驗證Active Watchlist `obv-s-buy`：17 requested／17 succeeded，依序產生51個Report／Trades／Reconciliation artifacts及final manifest。
- Live run開始與完成後Chart均為`TPEX:6693 / 1D`；最後一個Watchlist Symbol等於原始Symbol，因此final restore readback為success且`restored: false`，沒有不必要的Chart mutation。
