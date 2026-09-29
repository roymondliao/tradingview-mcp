---
id: TASK-004
title: Durable Experiment and Parameter Set Execution
status: todo
phase: strategy-durable-export-recovery
depends_on:
  - TASK-001
  - TASK-003
blocks:
  - TASK-005
  - TASK-006
scope: experiment-execution
---

# TASK-004: Durable Experiment and Parameter Set Execution

## Goal

建立以Experiment `manifest.json`為authoritative Symbol state的durable executor，並把Parameter Set execution拆成可persist plan、可選擇pending Experiments、可從Base Inputs安全恢復的seams。

## Code ownership

### Add

- `src/core/strategy-durable-experiment.js`
- `tests/strategy_durable_experiment.test.js`

### Modify

- `src/core/strategy-parameter-sets.js`
- `src/core/index.js`
- `package.json`

### Do not modify in this task

- Top-level `strategy run` orchestration。
- `strategy resume` loader／CLI。
- Lease implementation。

## Requirements

### Parameter Set seams

- Extract preparation from current`executeParameterSets()`：capture Base Inputs、build complete plans and return persistable values before anyParameter mutation。
- Extract execution of one prepared plan while preserving strict identity／Input／fresh Report checks。
- Support executing a selected ordered subset of persistedplans。
- Support restoring a persisted Base Input catalog before selected execution and in final cleanup。
- Existing `executeParameterSets()` remains available as a compatibility wrapper over new seams。
- Remove persisted`completed_at`from formal artifact v2 paths；use`updated_at`at mutable state level。

### Pre-mutation persistence contract

- Caller can persist`base_inputs`、base fingerprint and allplanned experiments before first Input mutation。
- `experiment_id`and fingerprints remain deterministic and includeartifact schema version 2 where identity semantics changed。
- Each Experiment writesimmutable`experiment.json`before applying effective Inputs or changing Symbols。
- Create `manifest.json(status=running)`before first Symbol attempt。

### Durable Experiment loop

- Load／validate existingmanifest or initialize a new one fromfrozen Watchlist。
- Accept selectedindices from Run／Resume planner。
- Never call retry executor formanifest `succeeded`entries。
- Each Symbol transition callback 透過 TASK-001 store atomically replaces manifest。
- Retry exhaustion marksSymbol failed and continuesnext Symbol。
- Fatal error 將 current Symbol／Experiment 標為 failed，並停止 new Symbols。
- Remaining entries may beexplicit `skipped`or implicit pending；both must beResume-eligible。
- After selected work, derivefull manifest summary from allrequested indices。
- Experiment becomes`succeeded`only if everyrequested Symbol is`succeeded`; otherwise`failed`。

### Restore semantics

- New Run captures Base once before all Experiments。
- Resume first validates current fingerprint is Base or one planned effective fingerprint, then restores Base。
- Selected Experiment effective Inputs always derive frompersisted Base, not previousExperiment logical values。
- Final Base restore executes on success、Symbol failures、fatal errors and graceful abort。
- Restore failure preservesprimary error in bounded diagnostics but`PARAMETER_SET_RESTORE_FAILED`remains terminal invocation error。

### Compatibility

- Existing `strategy_parameter_execution.test.js`behavior remains green through compatibility wrapper。
- Legacy Active Watchlist export does not use new durable Experiment executor。

## Tests

- Persistable preparation occurs before anysetStudyInputs call。
- New manifest implicit pending and per-transition atomic callbacks。
- Mixed succeeded／failed／running／retry_wait／skipped Resume selection。
- Succeeded Symbols generate zeroruntime calls。
- Retry-exhausted Symbol does not stop following Symbols。
- Fatal identity／artifact error stops followingSymbols and marks Experiment failed。
- Absent manifest runs full frozen Watchlist。
- Selected subset execution 仍 derives Inputs from Base。
- Crash-left planned effective Inputs accepted then restored；arbitrary fingerprint rejected byidentity helper seam。
- Base restore on success、failure and abort。
- Existing Parameter Set tests remain green。

## Acceptance criteria

- [ ] Base Inputs and allExperiment plans can becommitted before first Parameter mutation。
- [ ] Manifest is updated after every Symbol transition and is the onlySymbol status source。
- [ ] Experiment success requires every requested Symbol success。
- [ ] Resume can execute an arbitraryordered subset without rerunning succeeded Symbols。
- [ ] Every invocation attempts final Base Inputs restore。
- [ ] Compatibility wrapper preserves current non-durable callers，直到 TASK-006 switches formal Run。
- [ ] Targeted tests、full unit suite、lint and`git diff --check`pass。

## Completion record

Not started.
