---
id: TASK-004
title: Regression, Migration and Delivery
status: todo
phase: composable-error-handling
depends_on:
  - TASK-003
scope: repository-migration-delivery
---

# TASK-004: Regression, Migration and Delivery

## Goal

盤點並遷移其餘module-local error helpers，完成compatibility matrix、documentation、fault injection及release
evidence，確保新composition foundation不是只有Strategy特例。

## Expected ownership

- Remaining `src/core/**` error helpers
- CLI command validation boundaries
- MCP tool adapters
- Error inventory／manual test／release notes／delivery evidence

## Requirements

- Generate reviewed inventory of local error constructors、wrappers、message heuristics and result diagnostics。
- Classify each as keep-local mapper、shared mapper、source normalizer or presentation projection。
- Migrate by bounded module groups；每批都有tests，不執行blind mechanical rewrite。
- Remove permanent message-regex CDP detection after inventory reaches zero。
- Document additive runtime `kind` and unchanged artifact schemas。
- Add fault matrix for nested CDP／filesystem／interrupt/domain causes。
- Confirm no sensitive cause/stack/runtime object reaches CLI／MCP output。

## Validation

- `npm run lint`
- `fnm exec --using=22 npm run test:unit`
- `fnm exec --using=24 npm run test:unit`
- `npm run test:durable`
- `npm pack --dry-run`
- `npm run release:check-version`
- `git diff --check`
- Controlled CLI checks with Desktop available and unavailable

## Acceptance criteria

- [ ] Error inventory has no unreviewed module-local classifier。
- [ ] No production presentation layer classifies by message regex。
- [ ] CLI／MCP parity and exit-code matrix pass。
- [ ] Existing documented error codes have compatibility evidence。
- [ ] Artifact v2／v3／v4 regression passes without schema migration。
- [ ] Manual／release／delivery documentation is complete。
