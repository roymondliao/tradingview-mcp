---
id: TASK-007
title: Trading Data formats and artifact transaction
status: todo
phase: strategy-trading
depends_on:
  - TASK-004
  - TASK-006
blocks:
  - TASK-008
scope: local
---

# TASK-007: Trading Data formats and artifact transaction

## Goal

提供canonical Strategy Trading Data的JSON／JSONL／CSV streaming encoders，以及安全的staging／atomic artifact transaction，並擴充`trading-data --output`。

## Requirements

### In scope

- 新增`strategy-trading-format.js`與`artifacts.js`。
- Default JSON、JSONL metadata-first records與Desktop-semantic CSV rows。
- Format／extension inference與conflict errors。
- UTF-8、newline、CSV quote/null與schema version。
- Streaming batch write，避免全部Trades常駐memory。
- Safe Symbol path、existing output guard、`--force`、staging與atomic publish。
- `strategy trading-data --format/--output`CLI integration與JSON stdout summary。

### Out of scope

- XLSX、remote storage或UI Download click。
- TradingView reads、reconciliation或Watchlist flow。
- File-to-file JSON reparse conversion。

### Constraints and references

- [`Format module`](./LLD.md#new-srccorestrategy-trading-formatjs)
- [`Artifact module`](./LLD.md#new-srccoreartifactsjs)
- TASK-004 canonical model與TASK-006 batch contract。

## Design

Encoders只接受canonical objects並實作start／writeBatch／finish／abort。Artifact transaction提供same-filesystem staging與rename；partial output永遠不使用final filename。

## Verification and Delivery

### Tests

- JSON／JSONL／CSV golden fixtures與跨format canonical parity。
- Unicode、quotes、comma、newline、null與Open Trade rows。
- Format inference、extension mismatch與unsupported format。
- Existing file、force、write failure、abort與atomic publish。
- Large multi-batch streaming memory behavior。

### Acceptance criteria

- [ ] JSON為default且保留完整canonical envelope。
- [ ] JSONL／CSV由canonical objects直接產生。
- [ ] CSV涵蓋Desktop sample語意且不依locale headers。
- [ ] Partial／failed write不留下成功final artifact。
- [ ] CLI file output後stdout只回bounded JSON summary。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
```

### Deliverables

- Format encoders、artifact transaction、Trading Data output CLI、golden fixtures與tests/docs。

## Completion record

Not started.
