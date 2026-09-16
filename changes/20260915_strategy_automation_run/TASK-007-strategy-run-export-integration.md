---
id: TASK-007
title: Strategy Run Export Integration
status: todo
phase: strategy-automation-run
depends_on:
  - TASK-003
  - TASK-004
  - TASK-005
  - TASK-006
blocks:
  - TASK-008
scope: strategy-run-cli
---

# TASK-007: Strategy Run Export Integration

## Goal

交付正式`strategy run --config`，整合validated preflight、Strategy Sync、complete named Watchlist Snapshot、Parameter Set execution與既有Strategy Trading Report／Data export，產生canonical bounded summary與run artifacts。

## Requirements

### In scope

- New`strategy-run.js`application service與CLI registration。
- Formal run在任何mutation前重做TASK-004 preflight。
- Sync result的latest`entity_id`與Runtime Schema交給Parameter executor。
- Refactor existing Watchlist export internal seam接受caller-supplied immutable Snapshot與artifact namespace。
- 每個Parameter Set對同一ordered Snapshot sequential export全部Symbols。
- Reuse existing Report／Trading Data、snapshot consistency與five-metric reconciliation。
- `run.json`、`watchlist.json`、per-Experiment metadata／manifest與Symbol artifacts。
- Bounded stdout、exit codes、run collision與restore semantics。

### Out of scope

- 改變Trading Report／Trade canonical schemas與reconciliation rules。
- Active Watchlist DOM fallback。
- Per-Symbol retry／checkpoint／resume。
- ParallelParameter Sets／Symbols或high-level MCP run tool。

### References

- [`LLD Strategy Run`](./LLD.md#new-srccorestrategy-runjs)
- [`Artifact contract`](./LLD.md#artifact-contract)
- Existing`src/core/strategy-trading.js`and`artifacts.js`。

## Design

Application service直接呼叫Core functions，不啟動CLI subprocess。Named Snapshot只capture一次並傳給全部Experiments。Existing`exportStrategyWatchlist()`抽出可接受provided Snapshot與provided artifact transaction／namespace的internal seam，public legacy Active Watchlist contract保持相容。

Formal run成功會持久化latest Account／Pane Strategy revision；finally只恢復Base Inputs與原Symbol／Timeframe。沒有Durable contract前不得在response宣稱retry／resume支援。

## Verification and Delivery

### Tests

- One／multipleParameter Sets × one／multipleSymbols。
- Exact same Snapshot reused acrossExperiments，且不呼叫DOM capture。
- Create／update／reuse與add／refresh sync branches。
- Parameter set failure、Symbol partial failure、Trading reconciliation failure。
- JSON／JSONL／CSV parity與canonical artifact paths。
- Run ID auto／explicit、collision、bounded stdout與exit 0／1／2。
- Input／Chart restore success and failure。
- No CLI subprocess／no duplicate runtime expressions assertions。

### Acceptance criteria

- [ ] 一個command可從config完成Strategy sync與全部Experiments export。
- [ ] 每個Experiment使用相同Watchlist Snapshot與固定Strategy revision。
- [ ] Export前均有correct Inputs fingerprint與fresh Report evidence。
- [ ] Existing Strategy Trading reconciliation／snapshot guarantees保持不變。
- [ ] 完整artifacts可供外部`trading-cli`讀取，stdout維持bounded JSON。
- [ ] Response與文件不宣稱未實作的retry／resume能力。

### Validation commands

```bash
fnm exec --using=22 npm run lint
fnm exec --using=22 npm run test:unit
fnm exec --using=22 npm run test:cli
fnm exec --using=22 npm run tv -- strategy run --config ./run-config.json --dry-run
fnm exec --using=22 npm run tv -- strategy run --config ./run-config.json
```

### Deliverables

- Strategy Run application service／CLI、export integration seam、artifact set、tests、manual guide與example config。

## Completion record

Not started.

