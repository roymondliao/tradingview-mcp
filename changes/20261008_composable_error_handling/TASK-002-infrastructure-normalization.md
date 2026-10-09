---
id: TASK-002
title: Infrastructure Boundary Normalization
status: todo
phase: composable-error-handling
depends_on:
  - TASK-001
blocks:
  - TASK-003
scope: source-boundary-normalization
---

# TASK-002: Infrastructure Boundary Normalization

## Goal

讓CDP discovery/connect/command與owned filesystem boundaries在source處產生完整Core contract，並消除
`core/tab.js` production raw fetch，使所有Layout／Tab／status callers共用同一target discovery authority。

## Expected ownership

- `src/connection.js`
- `src/core/tab.js`
- `src/core/artifacts.js`
- `src/core/strategy-run-artifacts.js`
- Connection／Tab／artifact tests

## Requirements

- Export bounded `discoverCdpTargets()` from connection layer。
- Normalize fetch、timeout、HTTP及invalid target-list errors to `kind: cdp`。
- Make `CdpOperationError` satisfy Core contract without losing stage／timeout metadata。
- Replace `core/tab.js` direct global fetch with injected discovery dependency。
- Assign filesystem／artifact kinds at owned artifact boundaries。
- Preserve existing stable codes and existing test injection seams。
- No message-based classification above source adapters。

## Tests

- TradingView unavailable／ECONNREFUSED／generic fetch failure。
- Discovery timeout、HTTP non-2xx、non-array JSON。
- Status、Tab list and Layout resolution error parity。
- Target metadata failure remains separate from target-list discovery failure。
- Artifact ENOENT／EEXIST／symlink／write failure kinds。

## Acceptance criteria

- [ ] No production target-list caller directly uses global `fetch`。
- [ ] CDP failures always carry kind/code/stage before entering domain code。
- [ ] `tv status` and `tv tab list` expose equivalent discovery semantics。
- [ ] Targeted connection／tab／artifact tests pass。
