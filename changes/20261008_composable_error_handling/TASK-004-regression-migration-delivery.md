---
id: TASK-004
title: Regression, Migration and Delivery
status: complete
phase: composable-error-handling
depends_on:
  - TASK-003
scope: repository-migration-delivery
---

# TASK-004: Regression, Migration and Delivery

## Goal

盤點其餘module-local error helpers，完成本Feature vertical slice的migration、compatibility matrix、documentation、
fault injection及release evidence，並將已review但延後的module列入bounded follow-up inventory。

## Expected ownership

- Remaining `src/core/**` error helpers
- CLI command validation boundaries
- MCP tool adapters
- Error inventory／manual test／release notes／delivery evidence

Reviewed inventory is maintained in [`ERROR_INVENTORY.md`](./ERROR_INVENTORY.md)。

## Requirements

- Generate reviewed inventory of local error constructors、wrappers、message heuristics and result diagnostics。
- Classify each as source boundary、domain boundary、keep-local mapper、shared mapper or presentation projection。
- Migrate by bounded module groups；每批都有tests，不執行blind mechanical rewrite。
- Remove message-regex CDP detection after normalized diagnostics cover all production presentation entrypoints。
- Document field ownership、additive runtime `kind` and unchanged artifact schemas。
- Record exact legacy／persisted code-to-kind maps；不得使用prefix／substring inference。
- Add fault matrix for process signal、owned timeout、caller/cascade abort、CDP、artifact、filesystem and domain causes。
- Confirm no sensitive cause/stack/runtime object reaches CLI／MCP output。
- Track reviewed deferred modules explicitly；本Task不要求在同一PR進行unbounded repository rewrite。

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

- [x] Error inventory has no unreviewed module-local classifier。
- [x] Strategy／CDP／presentation vertical slice has no missing-kind normalized output。
- [x] Deferred modules are reviewed, classified and assigned bounded follow-up scope。
- [x] No production presentation layer classifies by message regex。
- [x] CLI／MCP parity and exit-code matrix pass。
- [x] Existing documented error codes have compatibility evidence。
- [x] Artifact v2／v3／v4 regression passes without schema migration。
- [x] Live Desktop manual evidence is complete。
