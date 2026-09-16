---
id: TASK-005
title: Strategy Account Sync and Safe Pane Refresh
status: todo
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

- [ ] Same normalized source不呼叫Account update。
- [ ] Changed sourcecompile成功後只新增一個Account version並read back。
- [ ] Stale Pane在new Instance驗證前不移除old。
- [ ] 成功refresh只剩一個latest matching Instance且回傳new`entity_id`。
- [ ] 任一failure不把未驗證new Instance冒充成功，並提供bounded cleanup state。

### Validation commands

```bash
fnm exec --using=22 npm run lint
fnm exec --using=22 npm run test:unit
fnm exec --using=22 npm run test:cli
```

### Deliverables

- Strategy Sync Core service、exports、deterministic transaction tests、structured errors與live refresh evidence。

## Completion record

Not started.

