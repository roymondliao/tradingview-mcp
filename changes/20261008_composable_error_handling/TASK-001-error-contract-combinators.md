---
id: TASK-001
title: Shared Error Contract and Combinators
status: todo
phase: composable-error-handling
blocks:
  - TASK-002
scope: core-error-foundation
---

# TASK-001: Shared Error Contract and Combinators

## Goal

擴充shared Core error contract，加入required internal kind、bounded cause traversal、safe diagnostic projection、
pure mapper composition及boundary factory。本Task不改變任何domain public code或CLI exit behavior。

## Expected ownership

- `src/core/errors.js`
- New `src/core/error-policy.js`
- Core error-policy unit tests

## Requirements

- Define fixed `CORE_ERROR_KINDS` and validate constructor input。
- Preserve current `CoreOperationError` fields and safe context behavior。
- Add cycle-safe、depth-16 cause traversal。
- Add `toCoreDiagnostic()` with one bounded safe-field allowlist。
- Implement mapper decline／match contract and ordered composition。
- Implement reusable interrupt、infrastructure promotion、preserve、translation and fallback mappers。
- Implement `createErrorBoundary()` with `error()`／`diagnostic()` parity。
- Never mutate or serialize source error/cause/stack。

## Tests

- Every kind and invalid kind。
- Primitive／plain-object／Error inputs。
- Cause chain depth 16／17 and cycle。
- Mapper ordering and final-fallback enforcement。
- Nested CDP cause wins over outer identity wrappers。
- Diagnostic size／field allowlist／context sanitization。
- Existing `CoreOperationError` callers remain source-compatible during migration。

## Acceptance criteria

- [ ] Foundation is dependency-leaf and domain-agnostic。
- [ ] Same normalized error projects deterministically。
- [ ] Cause and stack never enter diagnostics。
- [ ] Targeted tests and `git diff --check` pass。
