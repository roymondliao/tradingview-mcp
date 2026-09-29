---
id: TASK-006
title: Run and Resume Orchestration, CLI, and Signals
status: todo
phase: strategy-durable-export-recovery
depends_on:
  - TASK-001
  - TASK-002
  - TASK-003
  - TASK-004
  - TASK-005
blocks:
  - TASK-007
scope: application-integration
---

# TASK-006: Run and Resume Orchestration, CLI, and Signals

## Goal

將durable foundations整合進formal`strategy run`，完成獨立`strategy resume`CLI與shared execution service，並加入graceful SIGINT／SIGTERM contract；此Task是public behavior正式切換點。

## Code ownership

### Modify

- `src/core/strategy-run.js`
- `src/core/strategy-resume.js`
- `src/cli/commands/strategy.js`
- `src/cli/router.js`
- `tests/strategy_run.test.js`
- `tests/cli.test.js`
- `package.json`

### May modify through established seams

- `src/core/strategy-run-config.js`（collision recheck helper only）
- `src/core/index.js`

### Must preserve

- Dry-run read-only behavior andresponse contract。
- Existing `strategy trading-export`commands and V1 artifacts。
- Existing normal exit codes0／1／2。

## Requirements

### New Run orchestration

Implement order：

```text
full read-only preflight
  → acquire Run + Pane leases
  → recheck output collision and pinned Pane
  → direct-create canonical Run Directory
  → persist running run.json + watchlist.json
  → Strategy sync
  → persist resolved Strategy
  → prepare/persist Base Inputs + all Experiment plans
  → execute durable Experiments sequentially
  → restore Base Inputs and Chart
  → derive manifests/run summaries
  → run succeeded or failed
  → release leases
```

- No root-level`createArtifactSetTransaction()`forformal Run。
- Once durable initialization completed, catch must not delete Run Directory。
- Setup crash withmissing post-sync fields remainsResume-able through idempotent sync／plan completion。
- Symbol exhaustion continues otherSymbols／Experiments；fatal errors stop newmutation。
- Replace V1`partial`with`failed`forformal artifact v2 and bounded response。
- Removecompleted timestamps anduseupdated timestamps。
- Return`retry_supported: true`and`resume_supported: true`。
- Output response identifies`durable: true`andatomic scope rather than claiming whole-root terminal rename。

### Resume orchestration

- Export `resumeStrategyAutomation({ run_directory, signal, _deps })`。
- 使用 TASK-005 local validation、lease、rebind and plan。
- Aftervalidation setRun andselected Experiment status to`running`withupdated time。
- Complete unfinished setup idempotently whenresolved Strategy／Base plans are absent。
- RestoreBase Inputs beforeselected Experiment execution。
- Give everyselected Symbol anew retry executor invocation budget。
- Preserveoriginal Run ID／directory andnever createcontinuation output。
- Finalize`run.json`from allmanifests, including previously succeededExperiments。

### CLI

Register：

```bash
npm run tv -- strategy resume --run-directory <path>
```

- Required argument validation uses`RUN_RESUME_NOT_FOUND`orrequest validation error withoutCDP。
- No`--config`or retry flags。
- Stdout/stderr response remainsbounded。
- `strategy run`continues to rejectexistingRun ID; it never auto-Resumes。

### Signals

- CLI wrapper registersSIGINT／SIGTERM only forformal Run／Resume invocation andremoves listeners infinally。
- First signal aborts sharedAbortController。
- Retry backoff and pre-attempt checks observe signal。
- Current bounded runtime phase completes，then Chart／Base restore and Run failed `RUN_INTERRUPTED` state are attempted。
- Router supportsstructured `exit_code`130／143。
- Second signal exits immediately; tests injectprocess facade instead ofterminating test runner。

### Failure and restore

- Run-level error persisted only as`{ code, phase, message }`。
- If primary execution andrestore both fail, preserveprimary diagnostic plus terminal restore code in bounded response／Run error policy defined byLLD。
- Lease release is outermostfinally andtoken checked。
- State write failure may leave`running`; never report false success。

## Tests

- Formal Run uses canonical directory before first TradingView mutation。
- Preflight failure produces no directory／lease leak／mutation。
- Collision remains`RUN_OUTPUT_EXISTS`anddoes not auto-Resume。
- Successfulmulti-Experiment Run v2。
- Retry exhaustion producesfailed Run butcontinues remainingwork。
- Fatal error leaves durable state and stops later mutation。
- Resume same Run ID skips succeeded Symbols and Experiments。
- Resume aftersetup、Parameter Set、Symbol write、rename andmanifest callback crash fixtures。
- GracefulSIGINT／SIGTERM restore、state、lease andexit codes。
- Second signal simulatedhard exit leaves state recoverable。
- CDP failure exit code2 remains fornormalunsignaled failure response where applicable。
- Boundedresponse excludesSymbols／Trades。
- Existingdry-run andlegacy trading-export suites remain green。

## Acceptance criteria

- [ ] Formal Run no longer creates randomroot staging。
- [ ] EveryTradingView mutation happens afterinitial durable artifacts andlease acquisition。
- [ ] Resume is an explicit separateCLI and Core module。
- [ ] SameRun ID andexisting succeeded artifacts are preserved acrossResume。
- [ ] Formal Run public statuses are onlyrunning／succeeded／failed。
- [ ] Firstsignal performsbounded graceful handling；second signal hasdocumented abrupt semantics。
- [ ] No catch path deletes avalid initialized Run Directory。
- [ ] Targeted tests、full unit suite、lint and`git diff --check`pass。

## Completion record

Not started.
