---
id: TASK-005
title: Resume Loader, Planning, and Identity Rebind
status: todo
phase: strategy-durable-export-recovery
depends_on:
  - TASK-001
  - TASK-002
  - TASK-004
blocks:
  - TASK-006
scope: resume-core
---

# TASK-005: Resume Loader, Planning, and Identity Rebind

## Goal

實作獨立`strategy-resume.js`Core service的local loader、strict artifact audit、Resume plan與TradingView stable identity rebind，確保任何mutation前已證明這是同一個Run、Layout／Pane、Strategy、Inputs與Watchlist。

## Code ownership

### Add

- `src/core/strategy-resume.js`
- `tests/strategy_resume.test.js`
- `tests/strategy_resume_identity.test.js`

### Modify

- `src/core/strategy-run-resolver.js`（只新增可重用identity helpers）
- `src/core/index.js`
- `package.json`

### Do not modify in this task

- CLI registration and signal handling。
- New Run orchestration。
- Lease internal protocol。

## Requirements

### Local-only load and audit

- Resolve `run_directory` to absolute path，並呼叫 TASK-001 reader。
- Requireartifact schema v2；V1／unknown returns`RUN_RESUME_VERSION_UNSUPPORTED`。
- Reject`succeeded`Run with`RUN_ALREADY_SUCCEEDED`。
- ValidateRun ID/path、requested output path、Watchlist Snapshot、Experiment IDs、manifest indices／summary and allrelative paths。
- Verify allmanifest-succeeded Symbol artifacts before anyCDP call。
- Non-succeeded final folder never upgrades state；it is recorded ascleanup work。
- Produce boundedlocal summary and immutableResume plan。
- MissingRun／run.json maps to`RUN_RESUME_NOT_FOUND`; malformed／inconsistent maps to`RUN_RESUME_ARTIFACT_INVALID`。

### Ownership ordering

- AcquireRun lease using absoluteRun Directory before rereading artifacts。
- AcquirePane lease usingpersisted stable Pane key。
- Re-read and revalidate artifacts afterboth leases to close TOCTOU window。
- Expose an internal service callback，讓 TASK-006 可在 finally 保證 release。

### Stable runtime re-resolution

- Read persisted local Pine path and verify normalized source hash。
- Resolve exact Layout name and Pane index usingcurrent inventory。
- Compare saved Layout／Pane stable identifiers perLLD。
- Resolve exact Saved Strategy andverify script ID、version and source hash。
- Read matching Pane Strategy instances；require exactly one matching script/version。
- Allow rebind of`target_id`、`tab_index`andPane `entity_id`; update in-memory context only until execution commits newaudit binding。
- Verifycandidate schema and persisted Base／effective plans。
- Acceptcurrent runtime Inputs only when fingerprint equalsBase or oneplanned effective set；otherwise`RUN_RESUME_IDENTITY_MISMATCH`。
- Do not recapture current Watchlist；always usepersisted `watchlist.json`ordered Symbols。

### Planning

- `succeeded`Experiment: no mutation plan。
- Existing non-succeededmanifest: include onlyindices not`succeeded`。
- Missingmanifest for a persisted plan: include full frozen Watchlist。
- MissingExperiment plan for a requested Parameter Set is artifact invalid, not pending。
- Keep originalRun ID、experiment IDs、output format andtimeframe。
- Plan includes cleanup targets but performs no cleanup untilidentity validation and leases succeed。

### Error contract

- Implement exactResume errors inLLD／DECISIONS。
- Local validation failure must produce zeroCDP／TradingView calls。
- Stable mismatch must not mutateChart、Inputs or artifacts except lease metadata outsideRun Directory。

## Tests

- Missing、V1、unknown、malformed、symlink andoversized artifacts。
- Succeeded Run short-circuit beforeCDP。
- Manifest succeeded artifact missing／wrong path／wrong type。
- Mixed states produce exactpending index plan。
- Missing manifest creates fullExperiment plan。
- Frozen Watchlist used even ifAccount Watchlist changed。
- Target／tab／entity IDs changed butstable identity same succeeds。
- Layout、Pane、script、version、source、Input orWatchlist drift rejects。
- Current Inputs atBase／planned set accepted；arbitrary fingerprint rejected。
- DuplicateResume process blocked byleases。
- Artifacts changed betweeninitial read andpost-lock reread are rejected/replanned deterministically。

## Acceptance criteria

- [ ] Resume planning is complete before anyTradingView mutation。
- [ ] Onlymanifest `succeeded`entries are skipped。
- [ ] All succeeded artifacts are audited beforeexecution。
- [ ] Desktop restart volatile IDs can rebind without weakeningstable identity checks。
- [ ] Current Watchlist state is never used toreplace thefrozen Snapshot。
- [ ] Every local/artifact/identity failure uses thestructured error taxonomy。
- [ ] Targeted tests、full unit suite、lint and`git diff --check`pass。

## Completion record

Not started.
