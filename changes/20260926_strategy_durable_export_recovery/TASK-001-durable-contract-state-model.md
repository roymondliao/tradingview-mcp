---
id: TASK-001
title: Artifact v2 State Model and Durable Run Store
status: done
phase: strategy-durable-export-recovery
depends_on:
  - FEATURE-20260915-STRATEGY-AUTOMATION-RUN
blocks:
  - TASK-002
  - TASK-003
scope: core-state-and-filesystem
---

# TASK-001: Artifact v2 State Model and Durable Run Store

## Goal

建立formal Strategy Run artifact schema v2、pure state transitions與direct canonical Run filesystem store，取代`strategy run`未來不再使用的run-level random staging foundation；本Task只提供durable primitives，不改寫正式Run orchestration。

## Code ownership

### Add

- `src/core/strategy-run-state.js`
- `src/core/strategy-run-artifacts.js`
- `tests/strategy_run_state.test.js`
- `tests/strategy_run_artifacts.test.js`

### Modify

- `src/core/index.js`
- `package.json`

### Do not modify in this task

- `src/core/strategy-run.js`
- `src/core/strategy-trading.js`
- `src/core/strategy-parameter-sets.js`
- CLI commands

## Requirements

### Schema and transitions

- Define one formal artifact version constant：`STRATEGY_RUN_ARTIFACT_VERSION = 2`。
- Implement strict validators for `run.json`、`experiment.json` and `manifest.json` v2。
- Reject unknown fields where silent acceptance could affect identity、paths or status。
- Run／Experiment status only：`running|succeeded|failed`。
- Symbol status only：`running|retry_wait|succeeded|failed|skipped`; missing index is implicit pending。
- Implement immutable transition helpers and reject illegal transitions。
- Persist only bounded `error: { code, phase, message }`。
- Derive and validate manifest／Run summaries from authoritative records。
- Implement pure Resume plan generation that skips only`succeeded` Symbols。

### Durable store

- `createDurableRunStore()` exclusive-creates canonical Run Directory and maps collision to`RUN_OUTPUT_EXISTS`。
- `openDurableRunStore()` rejects missing、symlink or non-directory targets。
- Atomic JSON replace uses same-directory temp file、exclusive create、Node 22 flush、close and rename。
- All paths use existing safe relative path validation plus resolved containment checks。
- Reject symlink state files／Experiment directories／Symbol files。
- Provide bounded JSON reads with explicit maximum size and structured artifact errors。
- Provide initial Watchlist write、Run replace、Experiment create、Manifest replace and artifact info methods。
- No root-level`publish()`／`abort()` API；the canonical directory is durable once initialization completes。

### Symbol attempt filesystem primitive

- `beginSymbolAttempt()` creates:

```text
symbols/.<safe-symbol>.attempt-<attempt-count>.staging
```

- Provide file／stream writer methods required byReport、Trades and Reconciliation export。
- Flush all artifacts before same-filesystem rename to final Symbol directory。
- `commit()` must fail if requiredfiles are missing or destination already exists。
- `abort()` removes only the owned staging directory。
- Cleanup accepts only a validatednon-succeeded manifest entry and exact Symbol path。
- A manifest-succeeded final directory is immutable；missing files are corruption, not cleanup candidates。

### Compatibility

- Do not change `createArtifactSetTransaction()` semantics or tests。
- V1／unknown artifacts return`RUN_RESUME_VERSION_UNSUPPORTED` from the new reader。
- Config schema remainsversion 1。

## Tests

- Every legal／illegal state transition。
- Implicit pending and all summary counts。
- Malformed／oversized JSON、unknown schema、symlink and path traversal rejection。
- Run Directory collision and initialization I/O failure。
- Atomic JSON old-or-new visibility on write／flush／rename failures。
- Attempt write、flush、commit、abort and existing destination behavior。
- Crash fixtures forstaging-only and rename-before-manifest-callback windows。
- Succeeded manifest with missing artifacts returns`RUN_RESUME_ARTIFACT_INVALID`。
- Existing `tests/artifacts.test.js` remains green without expectation changes except shared helpers if required。

## Acceptance criteria

- [x] V2 schemas and transitions match[`LLD.md`](./LLD.md)。
- [x] Durable store writes directly under canonical Run Directory without random root staging。
- [x] State files are replaced atomically and never observed half-written in fault tests。
- [x] Symbol attempt directory is atomic as one unit and cannot overwrite succeeded evidence。
- [x] Resume plan is purely artifact-derived and never uses folder presence assuccess evidence。
- [x] V1 artifacts are rejected without mutation。
- [x] New modules are exported through Core index。
- [x] Targeted tests、full unit suite、lint and`git diff --check`pass。

## Completion record

Completed on 2026-09-29.

Implementation：

- Added `strategy-run-state.js` with artifact v2 validators、minimal state transitions、derived summaries andartifact-only Resume planning。
- Added `strategy-run-artifacts.js` with direct canonical Run store、bounded JSON reads、flushed atomic JSON replacement、attempt-owned Symbol staging／rename、ownership-gated cleanup andsucceeded artifact verification。
- Existing `createArtifactSetTransaction()`andformal `strategy run`behavior remain unchanged forlater integration tasks。

Validation：

- Node 22 targeted：27 tests passed。
- Node 24 targeted：27 tests passed。
- Node 22 full unit suite：555 tests passed，0 failed。
- ESLint：0 errors；repository仍有3個pre-existing unused-variable warnings outside thisTask。
- `git diff --check`passed。
