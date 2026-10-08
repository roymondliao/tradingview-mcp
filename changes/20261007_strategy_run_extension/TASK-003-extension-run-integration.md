---
id: TASK-003
title: Extension CLI, Durable Execution and Resume
status: done
phase: strategy-run-extension
depends_on:
  - TASK-002
blocks:
  - TASK-004
scope: extension-orchestration
---

# TASK-003: Extension CLI, Durable Execution and Resume

## Goal

整合`strategy extend`CLI、read-only preflight、ownership、child initialization、frozen Watchlist validation、
new-only durable execution及self-contained Resume。

## Expected ownership

- New `src/core/strategy-extend.js`
- `src/cli/commands/strategy.js`
- `src/core/strategy-run.js`
- New `src/core/strategy-durable-run-lifecycle.js`
- `src/core/strategy-resume.js`
- `src/core/strategy-durable-experiment.js`
- `src/core/strategy-run-artifacts.js`
- CLI／integration／fault tests

## Requirements

- Register exact `--run-directory`、`--config` and optional `--dry-run` surface。
- Refactor Run／Extend adapters to produce one `DurableRunExecutionSpec` and call one shared formal lifecycle。
- Reuse Run／Pane leases and signal/progress handling。
- Re-read Parent／Config after lock and before child create。
- Exclusive-create sibling child and persist fully planned v4 state before mutation。
- Copy frozen Watchlist membership and perform child validation。
- Apply Parent Base、execute only new plans、restore Base and finalize child。
- Parent tree remains bit/stable-hash unchanged on success／failure／signal／fault。
- Existing `strategy resume` completes v4 child without Parent reads。
- Responses remain bounded and include Parent/new counts。

## Tests

- CLI validation and help。
- Dry-run no writes/mutations。
- Successful 3-existing + 2-new Extension tree。
- Parent immutable assertions across all paths。
- Watchlist validation failure、retry exhaustion、fatal CDP、restore failure and signals。
- Crash points around child initial writes、manifest replace and final Run replace。
- Child Resume with Parent directory temporarily unavailable。
- Child Resume dependency injection makes any lineage-reader call fail the test。
- Chained Extension from successful child。

## Acceptance criteria

- [x] Command creates one child containing only new Experiments。
- [x] Parent never changes by construction and write-target tests。
- [x] Child follows all existing durability／retry／lease guarantees。
- [x] Run／Extend use one shared lifecycle；dry-run uses neither store nor mutation lifecycle。
- [x] Resume is self-contained and new-only。
- [x] Targeted CLI／Run／Resume／fault suites pass。
