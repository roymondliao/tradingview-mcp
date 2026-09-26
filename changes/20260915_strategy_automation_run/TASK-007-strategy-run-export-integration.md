---
id: TASK-007
title: Strategy Run Export Integration
status: done
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

- [x] 一個command可從config完成Strategy sync與全部Experiments export。
- [x] 每個Experiment使用相同Watchlist Snapshot與固定Strategy revision。
- [x] Export前均有correct Inputs fingerprint與fresh Report evidence。
- [x] Existing Strategy Trading reconciliation／snapshot guarantees保持不變。
- [x] 完整artifacts可供外部`trading-cli`讀取，stdout維持bounded JSON。
- [x] Response與文件不宣稱未實作的retry／resume能力。

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

Completed on 2026-09-18.

Implemented:

- `strategy run --config <path>`正式入口重用TASK-004 preflight，在任何mutation與artifact staging前重新驗證Config、Pine compiler、exact Layout／Pane／Saved Strategy、完整named Watchlist Snapshot及全部Parameter Sets。
- Formal run只capture一次完整named Snapshot；同一immutable object傳給所有Experiments，不讀取Active Watchlist DOM，也不切換Watchlist UI。
- 整合TASK-005 Strategy Sync的create／update／reuse與add／refresh／reuse plan revalidation，將readback後latest`script_id`、version、source hash與`entity_id`固定交給TASK-006 executor。
- 新增`exportStrategySnapshotIntoRun()`internal seam，接受caller-supplied Snapshot、artifact transaction與Experiment namespace；直接重用既有per-Symbol Report／Trading Data batching、snapshot consistency、five-metric reconciliation與format encoders，不複製runtime expressions或啟動CLI subprocess。
- Legacy`strategy trading-export --watchlist active`改為重用同一provided-Snapshot seam，既有CLI contract、partial manifest、fail-fast與Chart restore行為維持相容。
- Formal run從Strategy Sync開始到artifacts publish持有單一外層Chart Session mutex；Sync與Parameter executor使用already-locked seam，不產生nested mutex。每個Experiment依序export相同ordered Symbols，結束時先恢復Chart Symbol／Timeframe，再由Parameter executor確認Inputs／identity並於batch finally恢復Base Inputs。
- Formal run使用single same-filesystem staging transaction。只有preflight、sync、全部Parameter callbacks、Chart／Input restore與final metadata全部完成後才publish；fatal failure會abort staging。Symbol failure維持既有partial terminal manifest並以exit 1或CDP exit 2呈現。
- Canonical tree包含`run.json`、完整`watchlist.json`、每個Parameter Set的`experiment.json`／`manifest.json`及namespaced per-Symbol Report／Trades／Reconciliation artifacts；Run ID collision在Strategy mutation前拒絕，formal run不提供force。
- stdout只提供Run／Experiment／Symbol counts、fingerprints與artifact paths，不包含完整Symbols或Trades；response與artifacts明確標示`retry_supported: false`、`resume_supported: false`。
- 新增[`docs/strategy_automation_run_manual_test.md`](../../docs/strategy_automation_run_manual_test.md)，說明preflight、formal run、artifact與Desktop restore手測方式，並提醒大型Watchlist工作量。

Deterministic validation:

- Formal integration涵蓋multiple Parameter Sets × multiple Symbols、同一Snapshot object reuse、single outer Chart Session／no nested mutex、canonical namespaces、partial Experiment、Run collision、preflight no-mutation與Parameter／restore failure staging abort。
- Provided Snapshot seam驗證不呼叫Active Watchlist capture、不建立nested Chart Session，並正確輸出`experiments/<name>/symbols/...`。
- Existing Strategy Sync tests持續涵蓋create／update／reuse與Pane add／refresh／reuse；existing trading export tests持續涵蓋JSON／JSONL／CSV parity、snapshot drift、batch completeness、five-metric reconciliation及Chart restore failure。
- `fnm exec --using=22 npm run test:unit`：524 passed。
- `fnm exec --using=22 npm run test:cli`：31 passed。
- `fnm exec --using=22 npm run lint`：0 errors；3個既有warnings不在本Task範圍。

Live scope:

- TASK-006已在`dev`／`TWSE_DLY:2330`／`obv-v3`完成Inputs mutation、fresh Report與Base restore live evidence。
- TASK-007完成後的live formal preflight通過：Layout`dev`／Pane 0、Account與Pane`obv-v3`皆為v3.0且plan為`reuse`、35個Runtime Inputs、16個Candidate Inputs、`dev-testing-list`完整448 Symbols／stable reads 2，`blocked`與`errors`皆為空；全程read-only。
- 本Task未直接啟動example config的448-Symbol × 2-Parameter-Set完整export，以免在未經User明確安排的情況下執行大型工作；完整formal live acceptance保留給TASK-008 delivery gate。
