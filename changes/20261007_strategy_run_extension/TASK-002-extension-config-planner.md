---
id: TASK-002
title: Append-only Config Diff and Planning
status: done
phase: strategy-run-extension
depends_on:
  - TASK-001
blocks:
  - TASK-003
scope: extension-preflight-planning
---

# TASK-002: Append-only Config Diff and Planning

## Goal

建立pure Extension Config comparison、append-only suffix detection及Parent-Base new Experiment planning，
不建立child directory、不連接或mutation TradingView。

## Expected ownership

- New `src/core/strategy-extension-config.js`
- `src/core/strategy-run-config.js`
- `src/core/strategy-parameter-sets.js`
- Planner tests and fixtures

## Requirements

- Load existing Config v1 as complete desired lineage。
- Compare stable non-Experiment fields with Parent persisted request。
- Aggregate ancestor requested Parameter Sets in root→parent order。
- Enforce exact prefix and non-empty suffix。
- Reject delete／rename／input mutation／reorder／insertion／duplicate names。
- Resolve child Run ID and same-root output path safely。
- Validate new requested Inputs against Parent Base and matching Candidate schema。
- Require same saved Strategy and normalized Pine source hash；allow a different local source path and persist it in child。
- Produce bounded dry-run projection and v4 child metadata／plans inputs。
- No current Pane values may become Base Inputs。

## Tests

- Full prefix-diff matrix and stable ordering。
- Config/source/output identity mismatch matrix。
- Same source at different path succeeds；different source hash requires new standalone Run。
- Child ID generated／explicit／ancestor collision。
- Input unknown/type/range/step/options errors。
- Chained ancestry and config/run/local index mapping。
- Dry-run response bounds and no filesystem writes。

## Acceptance criteria

- [x] Exact-prefix comparison is deterministic and side-effect free。
- [x] Only config suffix is returned as new work。
- [x] Existing experiments can never be silently reinterpreted。
- [x] Parent Base drives every effective plan fingerprint。
- [x] Targeted tests and `git diff --check` pass。
