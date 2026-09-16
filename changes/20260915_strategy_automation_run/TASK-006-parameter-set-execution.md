---
id: TASK-006
title: Parameter Set Planning and Execution
status: todo
phase: strategy-automation-run
depends_on:
  - TASK-002
  - TASK-004
  - TASK-005
blocks:
  - TASK-007
scope: strategy-experiments
---

# TASK-006: Parameter Set Planning and Execution

## Goal

在fixed latest Strategy revision與Pane Instance上，建立多組explicit Parameter Sets的deterministic planning、name-to-ID resolution、Inputs mutation、fresh calculation等待與Base Inputs restore workflow。

## Requirements

### In scope

- Unique／path-safeParameter Set names與declared ordering。
- Base Inputs capture與complete fingerprint。
- 每組Effective Inputs=`Base + current overrides`，不繼承上一組。
- Candidate／Runtime Schema雙重value validation與name-to-current-ID mapping。
- Study Input mutation、complete readback與fixed identity assertions。
- Before Report state、recalculation／freshness／stable Report wait。
- Per-Experiment identity與metadata projection。
- `finally`Base Inputs restore及readback。

### Out of scope

- Parameter grid generation／optimizer。
- Symbol／Watchlist export與artifact format。
- Cross-Pane或parallelParameter Sets。
- Durable progress、retry或resume。

### References

- [`Base Strategy and Parameter Sets`](./STRATEGY_PARAMETER_SETS.md)
- [`LLD Parameter Sets`](./LLD.md#new-srccorestrategy-parameter-setsjs)

## Design

新增`strategy-parameter-sets.js`，pure planner產生每組requested names、resolved current IDs、complete Effective Inputs與fingerprint。Runtime executor每次從Base plan套用，不將上一組actual state作為下一組base；即使相鄰組相同，也要read back fixed identity後才可視為no-op。

Freshness不依賴metrics差異。Mutation前保存runtime state；mutation後要求expectedInputs fingerprint、calculation transition或可信generation change，以及至少兩次相同stable Report state。Operation callback供TASK-007執行existing Trading export。

## Verification and Delivery

### Tests

- Empty baseline與multiple explicit sets ordering。
- Base merge不受previous actual state污染。
- Name mapping、reordered runtime IDs、type／constraint／ambiguous failures。
- Same-value no-op與changed value mutation。
- Fixed script／version／entity／context assertions。
- Report transition、same-metrics-but-new-inputs、timeout與runtime error。
- Operation failure仍restore Base；restore mismatch使run failure。
- Experiment identity／timestamps／fingerprints determinism。

### Acceptance criteria

- [ ] 多組Parameter Sets依config順序執行。
- [ ] 每組都由相同Base Inputs建立。
- [ ] Export callback前已確認Inputs readback與fresh stable Report。
- [ ] Batch結束或任何failure後Base Inputs完成restore readback。
- [ ] Source version或`entity_id`中途改變時立即停止。

### Validation commands

```bash
fnm exec --using=22 npm run lint
fnm exec --using=22 npm run test:unit
fnm exec --using=22 npm run test:cli
```

### Deliverables

- Parameter Set planner／executor、freshness integration、restore guard、tests與experiment metadata model。

## Completion record

Not started.

