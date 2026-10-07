---
id: TASK-002
title: Run Writers and Format-Preserving Resume
status: done
phase: strategy-run-schema-naming
depends_on:
  - TASK-001
blocks:
  - TASK-003
scope: run-resume-integration
---

# TASK-002: Run Writers and Format-Preserving Resume

## Goal

讓new Formal Run輸出artifact v3 explicit fields，並讓Resume對existing v2與new v3都採用same-family serialization。

## Expected ownership

- `src/core/strategy-run.js`
- `src/core/strategy-run-artifacts.js`
- `src/core/strategy-durable-experiment.js`
- `src/core/strategy-resume.js`
- Relevant Run／Resume／artifact integration tests and fixtures

## Requirements

- Initial new `run.json`使用`artifact_schema_version: 3`。
- Config v1 normalized projection使用`requested.config_schema_version: 1`。
- New Experiment／manifest使用v3 root field。
- Store open/load保留authoritative Run family。
- Every Resume write path receives family explicitly。
- V2 Resume updates保持v2；v3 Resume updates保持v3。
- Missing Experiment setup during Resume繼承Run family。
- Mixed trees在任何TradingView mutation前失敗。
- Atomic write／fault recovery guarantees不變。

## Tests

- New Run artifact tree exact shape。
- V2 and v3 Resume success paths。
- V2 and v3 failed/running transition paths。
- Mixed-family permutation matrix。
- Missing Experiment creation for both families。
- Fault injection around Run and manifest replacement。
- No changes to Trading Export or Watchlist validation artifacts。

## Acceptance criteria

- [x] New Run tree只使用v3 explicit names。
- [x] Existing v2 Run可原地Resume且沒有任何v3 key。
- [x] V3 Run可Resume且沒有任何legacy formal root key。
- [x] No partial migration path exists。
- [x] Targeted Run／Resume／fault tests pass。

## Completion record

Completed on 2026-10-07.

- New Formal Runs write v3 `run.json`、`experiment.json` and `manifest.json`。
- Durable store binds one artifact family per Run Directory and rejects mixed writes。
- Full Resume integration verifies a legacy v2 Run remains v2 after successful completion。
