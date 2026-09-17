---
id: TASK-005
title: Strategy Account Sync and Safe Pane Refresh
status: done
phase: strategy-automation-run
depends_on:
  - TASK-001
  - TASK-002
  - TASK-004
blocks:
  - TASK-006
  - TASK-007
scope: account-and-pane-strategy
---

# TASK-005: Strategy Account Sync and Safe Pane Refresh

## Goal

建立可重用Strategy Sync application service，依dry-run plan自動create／update／reuse Account private Saved Strategy，並在不先破壞舊Instance的前提下將指定Pane安全同步至latest verified version。

## Requirements

### In scope

- Normalized source hash與stale-plan revalidation。
- Account create／update／reuse、compile gate、source／type／version readback。
- Pane zero／latest／stale／ambiguous plan與ownership guards。
- Add latest before remove old transaction。
- Candidate／new Runtime Input Schema readback comparison。
- Same-name compatible old Inputs migration、added default與removed／incompatible diagnostics。
- New Strategy activation、fresh／stable Report validation。
- Failure cleanup與partial Account-latest／Pane-stale retryable state。
- Stable sync result含new`script_id`、version、`entity_id`與fingerprints。

### Out of scope

- Parameter Sets iteration、Watchlist export或artifact tree。
- Saved Script delete或Publish。
- Retry/backoff orchestration。
- User-facing standalone`strategy sync --config`；formal入口由TASK-007的`strategy run`提供。

### References

- [`Strategy Source Sync and Update`](./STRATEGY_SYNC_UPDATE.md)
- [`LLD Strategy Sync`](./LLD.md#new-srccorestrategy-syncjs)
- `dev`／`obv-v3`v1→v2→v3live evidence。

## Design

新增`strategy-sync.js`的pure plan與effectful execute layers。Execute前重新確認Account source與Pane ownership仍符合plan。Refresh期間old Instance保持可用；只有new version、Runtime Schema、Inputs、active source與Report全部通過才remove old。

Cleanup只能使用本次add response的new`entity_id`，並在remove前再次確認`script_id`／version ownership。Account update成功後不嘗試刪除version；Pane失敗回傳可由下次run以Account reuse＋Pane refresh恢復的state。

## Verification and Delivery

### Tests

- Account missing／same／changed／duplicate與compile failure。
- CRLF／LF equal不建立version；content change只建立一個version。
- Account readback source／type／version mismatch。
- Pane missing add、latest reuse、stale refresh、multiple ambiguous。
- Add／schema／inputs／activation／Report／old remove各phase failure。
- New cleanup成功／失敗、old preservation與partial sync retry plan。
- Input schema reorder、added、removed、compatible／incompatible value migration。
- `entity_id`change與final one-latest-instance readback。

### Acceptance criteria

- [x] Same normalized source不呼叫Account update。
- [x] Changed sourcecompile成功後只新增一個Account version並read back。
- [x] Stale Pane在new Instance驗證前不移除old。
- [x] 成功refresh只剩一個latest matching Instance且回傳new`entity_id`。
- [x] 任一failure不把未驗證new Instance冒充成功，並提供bounded cleanup state。

### Validation commands

```bash
fnm exec --using=22 npm run lint
fnm exec --using=22 npm run test:unit
fnm exec --using=22 npm run test:cli
```

### Deliverables

- Strategy Sync Core service、exports、deterministic transaction tests、structured errors與live refresh evidence。

## Completion record

Completed on 2026-09-17.

Implemented:

- 新增compile-gated`executeStrategySync()`application service；正式執行前重算normalized source hash、重新解析exact-name Account Strategy與指定Pane ownership，並拒絕stale dry-run plan。
- Account支援private create／update／reuse；readback強制驗證`script_id`、exact saved name、type=`strategy`、normalized source hash與version，update必須建立新version且保持相同`script_id`。
- Pane支援missing add、latest reuse與stale refresh。Refresh固定先add latest，完成version／Runtime Input Schema／Inputs／active Strategy／stable Report驗證後才remove old，最後要求只剩一個latest matching Instance。
- Candidate／Runtime Schema只比較已定案的type、default、min與max；same-name且相容的舊Input values會重新映射至新版`in_x`，新增Input使用新版default，移除或不相容項目提供diagnostics。
- Failure cleanup只操作本次transaction readback取得的new`entity_id`，且再次驗證`script_id`與version ownership；錯誤回傳Account／Pane partial state、cleanup結果及下一次`reuse + refresh/add_latest`或人工inspect recovery plan。
- 共用Parameter Set的Input type／value validator與exact-ID Pane Strategy inventory，避免Strategy Sync另建不一致的validation規則。

Deterministic validation:

- `tests/strategy_sync.test.js`共30 tests，涵蓋create／reuse／update、CRLF normalization、stale plan、Account與Pane identity/version mismatch、完整Runtime Input reorder/add/remove/incompatible migration、concurrent ownership change，以及add/schema/inputs/activation/report/old-remove各phase failure與cleanup failure。
- `fnm exec --using=22 npm run lint`：0 errors；3個既有warnings不在本Task範圍。
- `fnm exec --using=22 npm run test:unit`：506 passed；其中targeted Strategy Sync suite為30 passed。
- `fnm exec --using=22 npm run test:cli`：31 passed。

Live Desktop 3.4.0 reuse evidence:

- Target為Layout`dev`／Pane 0，Symbol`TWSE_DLY:2330`、Timeframe`1D`；Account exact-name`obv-v3`與Pane皆為version`3.0`。
- Local／Account normalized source SHA-256皆為`5405a80b0702e289d821321383423d932639ae0862603ad91eacce9805bf714c`，執行結果為Account`reuse`與Pane`reuse`，未create／update Account、未add／remove Pane、未set Inputs。
- Readback維持`script_id=USER;639b20c65fbb456cb769054b72623d40`、`entity_id=hdn44B`；Runtime Inputs fingerprint為`d084bf5c1174577630a6be564cf7ed081c899f7c3bbfd2ba1a7b120e425fa219`（35 Inputs），Candidate Schema fingerprint為`320dfa20e7861ffd7b0da7cb6072150f7695ce22cd0d186e84e33590a9dc4122`（16 Inputs），Report連續3次stable read通過。
- Changed-source add-before-remove live behavior沿用本feature文件已記錄的controlled v1→v2→v3 evidence；本次驗證刻意不建立不可逆的v4。
