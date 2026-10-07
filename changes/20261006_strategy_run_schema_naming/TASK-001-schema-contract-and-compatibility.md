---
id: TASK-001
title: Artifact v3 Contract and Dual-Version Validation
status: done
phase: strategy-run-schema-naming
depends_on:
  - FEATURE-20260926-STRATEGY-DURABLE-EXPORT-RECOVERY
blocks:
  - TASK-002
scope: core-schema-validation
---

# TASK-001: Artifact v3 Contract and Dual-Version Validation

## Goal

建立formal artifact v3 explicit version fields，並讓Core reader可strictly辨識合法v2／v3 documents及拒絕所有ambiguous或mixed shapes。本Task先完成pure contract與validator，不切換正式Run writer。

## Primary ownership

- `src/core/strategy-run-state.js`
- `tests/strategy_run_state.test.js`
- Shared test fixture builders directly owned by state validation tests

## Requirements

- Current write version升為3，另有named legacy v2 constant。
- Define deterministic family detection without truthy fallback。
- V2 strict fields保留root `schema_version`與`requested.schema_version`。
- V3 strict fields使用root `artifact_schema_version`與`requested.config_schema_version`。
- Run／Experiment／manifest validators接受expected family。
- Cross-family、dual-field、missing-field與unknown versions有stable structured errors。
- Existing status transitions、summary derivation、identity validation semantics不變。
- Internal family metadata不可被JSON serialization洩漏。

## Tests

- Valid v2/v3 contract matrix。
- Version scalar type and unknown version matrix。
- Requested Config version key/value matrix。
- Unknown field rejection per family。
- Transition helpers retain input family。
- Error code／phase and bounded message assertions。

## Acceptance criteria

- [x] Pure validators可完整區分v2與v3。
- [x] V2 tests繼續證明legacy contract可讀。
- [x] V3 tests證明explicit names是唯一合法new shape。
- [x] No formal artifact writer behavior changes before TASK-002。
- [x] Targeted tests與`git diff --check`pass。

## Completion record

Completed on 2026-10-07.

- Added deterministic artifact-family detection and explicit v2／v3 validators。
- Added purpose-specific version-field builders and family-preserving transition validation。
- Added dual-field、unknown-version、cross-family and requested Config version coverage。
