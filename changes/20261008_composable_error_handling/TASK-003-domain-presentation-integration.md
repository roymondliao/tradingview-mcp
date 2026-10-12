---
id: TASK-003
title: Domain Boundaries and Presentation Parity
status: done
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
- Attach owned workflow phase while preserving source code／kind／stage／message。
- Preserve typed abort reason；promote only normalized CDP／generic filesystem causes before identity translation。
- Translate Resume identity to Extension identity only for true semantic identity errors。
- Use `CORE_UNCLASSIFIED_ERROR / internal` for unknown errors；never use an identity fallback code。
- Replace duplicate `diagnostic()` implementations with boundary diagnostics。
- Replace CLI message regex with fixed `0/1/2/130/143` kind/signal exit policy。
- For aggregated results, explicit 130／143 wins；otherwise any reportable `kind: cdp` yields 2，other failures yield 1。
- Make MCP `coreErrorPayload()` consume `toCoreDiagnostic()`。
- Preserve bounded errors arrays and result response compatibility。
- Keep persisted artifact errors exact `{code, phase, message}`。
- Rehydrate persisted runtime kind with a Strategy-owned exact code map；unknown codes remain intact and use runtime internal kind。

## Required scenarios

| Scenario | Expected result |
| --- | --- |
| Desktop offline during Extend dry-run | `CDP_DISCOVERY_FAILED`, `kind: cdp`, exit 2 |
| Layout `dev` not open | `TARGET_LAYOUT_NOT_OPEN`, `kind: validation`, exit 1 |
| Layout resolves but saved identity differs | `RUN_EXTENSION_IDENTITY_MISMATCH`, `kind: identity`, exit 1 |
| Parent artifact missing | Existing lineage/artifact code, artifact kind |
| SIGINT/SIGTERM | `RUN_INTERRUPTED`, interrupt kind, owning phase + `process_signal` stage, exit 130/143 |
| CDP-owned AbortError timeout | `CDP_TIMEOUT`, cdp kind, exit 2 |
| Unknown error during Extension identity | `CORE_UNCLASSIFIED_ERROR`, internal kind, bounded root-cause message, exit 1 |

## Tests

- Dry-run/formal same-cause contract parity。
- CLI/MCP exact field parity。
- Nested cause promotion through Resume→Extension wrappers。
- Phase／stage coexistence and no historical `phase: signal` write on new interrupt errors。
- Aggregated exit behavior does not depend on first-error ordering。
- No stack/cause leak。
- Existing Strategy error codes and bounded responses non-regression。
- V2／v3／v4 persisted error shape remains readable／write-compatible，including historical `phase: signal`。
- Exact persisted code-to-kind rehydration and unknown persisted code behavior。

## Acceptance criteria

- [x] Motivating Extend dry-run misclassification is fixed。
- [x] Presentation layers perform no domain classification。
- [x] CLI exit code no longer depends on error message text。
- [x] CLI and MCP receive only normalized diagnostics with known kind。
- [x] Strategy targeted and durable suites pass。
