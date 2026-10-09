---
id: TASK-003
title: Domain Boundaries and Presentation Parity
status: todo
phase: composable-error-handling
depends_on:
  - TASK-002
blocks:
  - TASK-004
scope: strategy-cli-mcp-integration
---

# TASK-003: Domain Boundaries and Presentation Parity

## Goal

將Strategy Run／Resume／Extend的local wrappers改為composed boundaries，並讓dry-run、formal、CLI與MCP
使用同一diagnostic projection及kind-based exit policy。

## Expected ownership

- `src/core/strategy-run.js`
- `src/core/strategy-resume.js`
- `src/core/strategy-extend.js`
- `src/core/strategy-run-resolver.js`
- `src/cli/router.js`
- `src/tools/_format.js`
- Strategy／CLI／MCP parity tests

## Requirements

- Define Run、Resume and Extension boundary policies from shared mappers。
- Promote interrupt／CDP／filesystem causes before identity translation。
- Translate Resume identity to Extension identity only for true semantic identity errors。
- Replace duplicate `diagnostic()` implementations with boundary diagnostics。
- Replace CLI message regex with kind-based exit code。
- Make MCP `coreErrorPayload()` consume `toCoreDiagnostic()`。
- Preserve bounded errors arrays and result response compatibility。
- Keep persisted artifact errors exact `{code, phase, message}`。

## Required scenarios

| Scenario | Expected result |
| --- | --- |
| Desktop offline during Extend dry-run | `CDP_DISCOVERY_FAILED`, `kind: cdp`, exit 2 |
| Layout `dev` not open | `TARGET_LAYOUT_NOT_OPEN`, `kind: validation`, exit 1 |
| Layout resolves but saved identity differs | `RUN_EXTENSION_IDENTITY_MISMATCH`, `kind: identity`, exit 1 |
| Parent artifact missing | Existing lineage/artifact code, artifact kind |
| SIGINT/SIGTERM | `RUN_INTERRUPTED`, interrupt kind, exit 130/143 |

## Tests

- Dry-run/formal same-cause contract parity。
- CLI/MCP exact field parity。
- Nested cause promotion through Resume→Extension wrappers。
- No stack/cause leak。
- Existing Strategy error codes and bounded responses non-regression。
- V2／v3／v4 persisted error shape remains readable／write-compatible。

## Acceptance criteria

- [ ] Motivating Extend dry-run misclassification is fixed。
- [ ] Presentation layers perform no domain classification。
- [ ] CLI exit code no longer depends on error message text。
- [ ] Strategy targeted and durable suites pass。
