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

擴充shared Core error contract，明確定義code／kind／phase／stage責任，加入normalized-output required kind、
bounded cause traversal、safe diagnostic projection、pure mapper composition及boundary factory。本Task不改變任何
domain public code或CLI exit behavior。

## Expected ownership

- `src/core/errors.js`
- New `src/core/error-policy.js`
- Core error-policy unit tests

## Requirements

- Define fixed `CORE_ERROR_KINDS` and normalized-contract validation。
- Preserve current `CoreOperationError` fields and safe context behavior；新增metadata使用explicit allowlist，不spread raw fields。
- Migration期間constructor允許legacy missing kind，但不得默認為`internal`；normalized boundary output必須有kind。
- Add cycle-safe cause traversal，最多檢查16個object nodes，且不讀取accessor getter。
- Add `toCoreDiagnostic()` with one bounded safe-field allowlist。
- Implement mapper decline／match contract and ordered composition。
- Implement reusable typed abort preservation、normalized infrastructure promotion、preserve、exact translation and fallback mappers。
- Unknown fallback固定`CORE_UNCLASSIFIED_ERROR / internal`並保留bounded safe deepest root-cause message。
- Implement `createErrorBoundary()` with `error()`／`diagnostic()` parity。
- Never mutate or serialize source error/cause/stack。

## Tests

- Every kind、invalid kind及field ownership。
- Legacy missing-kind input versus normalized-output requirement。
- Primitive／plain-object／Error inputs。
- Cause chain 16／17 nodes、cycle及throwing getter。
- Mapper ordering and final-fallback enforcement。
- Nested CDP cause wins over outer identity wrappers。
- Raw errno／AbortError does not get classified by a generic mapper。
- Unknown fallback never emits a semantic identity／validation code。
- Diagnostic size／field allowlist／context sanitization。
- Existing `CoreOperationError` callers remain source-compatible during migration。

## Acceptance criteria

- [ ] Foundation is dependency-leaf and domain-agnostic。
- [ ] Presentation cannot receive a missing-kind legacy error。
- [ ] Same normalized error projects deterministically。
- [ ] Cause and stack never enter diagnostics。
- [ ] Targeted tests and `git diff --check` pass。
