---
id: TASK-001
title: Artifact v4 and Lineage Contract
status: done
phase: strategy-run-extension
depends_on:
  - FEATURE-20261006-STRATEGY-RUN-SCHEMA-NAMING
blocks:
  - TASK-002
scope: artifact-lineage-model
---

# TASK-001: Artifact v4 and Lineage Contract

## Goal

新增strict formal artifact v4、standalone／extension discriminator、lineage metadata及safe ancestor reader，
同時保持v2／v3 Resume format compatibility。本Task不新增CLI或執行Extension。

## Expected ownership

- `src/core/strategy-run-state.js`
- `src/core/strategy-run-artifacts.js`
- New `src/core/strategy-run-lineage.js`
- State／artifact／lineage tests and fixtures

## Requirements

- Add v4 family without weakening v2／v3 validators。
- V4 `run_kind` required；extension metadata strict and bounded。
- New standalone writer target becomes v4；existing v2／v3 transitions retain family。
- V4 Experiment／manifest roots match Run family。
- Define stable Parent Run and ordered Parameter Set fingerprints。
- Implement versioned Parent／lineage fingerprint payloads that exclude runtime IDs and large Symbol payloads。
- Implement same-root safe ancestor traversal with cycle detection、Extension depth 64、4096 Experiments and
  64 MiB cumulative JSON bounds。
- Validate complete succeeded Parent evidence without mutation。
- No Parent path traversal、symlink following or unbounded JSON reads。

## Tests

- Valid／invalid standalone and extension v4 shapes。
- Dual／unknown version fields and mixed tree matrix。
- V2／v3 legacy Resume non-regression。
- Parent fingerprint stability under key ordering but sensitivity to identity changes。
- Missing／cycle／duplicate／symlink／escape／depth/count/byte-limit lineage fixtures。
- Resume validator accepts a complete child without calling the lineage reader。

## Acceptance criteria

- [x] V4 contract and lineage reader are pure/read-only。
- [x] New standalone artifacts can be represented in v4。
- [x] Existing v2／v3 runs remain readable and format-preserving。
- [x] Ancestor corruption fails with `RUN_EXTENSION_LINEAGE_INVALID`。
- [x] Targeted tests and `git diff --check` pass。
