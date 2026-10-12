---
id: TASK-002
title: Source Boundary and Abort Normalization
status: todo
phase: composable-error-handling
depends_on:
  - TASK-001
blocks:
  - TASK-003
scope: source-boundary-normalization
---

# TASK-002: Source Boundary and Abort Normalization

## Goal

讓CDP discovery/connect/command、owned deadlines與filesystem/artifact operations在擁有operation semantics的
source處產生完整Core contract，並消除`core/tab.js` production raw fetch，使所有Layout／Tab／status callers
共用同一target discovery authority。

## Expected ownership

- `src/connection.js`
- `src/core/tab.js`
- `src/core/artifacts.js`
- `src/core/strategy-run-artifacts.js`
- `src/cli/commands/strategy.js`
- Connection／Tab／artifact tests

## Requirements

- Export bounded `discoverCdpTargets()` from connection layer。
- Normalize fetch、timeout、HTTP及invalid target-list errors to `kind: cdp`。
- Make `CdpOperationError` extend the Core carrier with fixed `kind: cdp`，without losing stage／timeout metadata。
- Treat AbortSignal as a carrier：typed reason、owner deadline、caller cancel and cascade cancellation remain distinct。
- Ensure SIGINT／SIGTERM reasons carry interrupt kind、current workflow phase、`process_signal` stage and 130／143。
- Replace `core/tab.js` direct global fetch with injected discovery dependency。
- Classify required artifact failure、immutable collision and generic filesystem failure by owned operation semantics。
- Preserve existing stable codes and existing test injection seams。
- No raw errno、AbortError、prefix or message-based classification above source adapters。

## Tests

- TradingView unavailable／ECONNREFUSED／generic fetch failure。
- Discovery owned timeout、external typed cancellation、HTTP non-2xx、non-array JSON。
- Status、Tab list and Layout resolution error parity。
- Target metadata failure remains separate from target-list discovery failure。
- Required artifact ENOENT、immutable output EEXIST、generic filesystem write and symlink failure kinds。
- SIGINT／SIGTERM、caller cancellation、cascade cancellation、lease loss and ownerless AbortError matrix。

## Acceptance criteria

- [ ] No production target-list caller directly uses global `fetch`。
- [ ] CDP failures always carry kind/code/stage before entering domain code。
- [ ] Owned timeout cannot be misclassified as interrupt；cascade preserves primary reason。
- [ ] Raw filesystem errno is classified by operation owner, not a global errno mapper。
- [ ] `tv status` and `tv tab list` expose equivalent discovery semantics。
- [ ] Targeted connection／tab／artifact tests pass。
