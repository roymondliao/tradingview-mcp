# Composable Error Handling — Delivery Evidence

Status: complete for release `1.4.1`。

Date: 2026-10-12

## Implemented

- Shared Core error kinds、safe carrier、16-node cause traversal and deterministic diagnostic projection。
- Pure mapper composition and reusable error boundaries。
- Typed CDP errors and one target-discovery source authority。
- Owner-aware process signal、deadline、cascade and ownerless abort behavior。
- Operation-owned artifact／conflict／filesystem classification。
- Strategy Run／Resume／Extend diagnostic normalization and exact identity translation。
- Runtime kind rehydration from strict persisted Strategy error records。
- Shared CLI／MCP projection and fixed 0／1／2／130／143 exit policy。
- Reviewed migration inventory for bounded follow-up work。

## Automated validation

| Gate | Result |
| --- | --- |
| Node 22 unit suite | 720 passed，0 failed |
| Node 24 unit suite | 720 passed，0 failed |
| Durable suite | 133 passed，0 failed |
| ESLint | 0 errors；3 pre-existing unused-variable warnings |
| Package dry-run | Passed with isolated npm cache；276 files |
| Version synchronization | 1.4.1 synchronized |
| Diff whitespace validation | Passed |
| Markdown links／fences | Passed for feature documents |

## Fault evidence

- Raw CDP fetch failure normalizes to CDP_DISCOVERY_FAILED／cdp／target_discovery。
- CDP-owned AbortError deadline normalizes to CDP_TIMEOUT，not interrupt。
- SIGINT and SIGTERM preserve typed interrupt reasons and 130／143。
- Ownerless abort normalizes to CORE_UNCLASSIFIED_ERROR／internal。
- Nested CDP cause wins over Resume→Extension identity translation。
- Unknown Extension identity failure does not become RUN_EXTENSION_IDENTITY_MISMATCH。
- Required artifact ENOENT、immutable collision and generic write failure remain distinct。
- Persisted error records remain exact { code, phase, message } and recover runtime kind by exact map。
- CLI aggregation returns 2 when one reportable diagnostic has kind cdp。

## Live manual validation

- Strategy Run SIGINT returned exit 130、`interrupt` kind and `strategy_run_execution` phase。
- Strategy Resume SIGINT preserved the Run ID、durable progress and `strategy_resume_execution` phase。
- A subsequent Resume completed all 7 Experiments and 700 Symbols without replaying completed work。
- Strategy Extension SIGINT during Watchlist validation created an immutable Child with one new Experiment、exit 130 and `strategy_extension_execution` phase。
- Failed durable artifacts retained the strict `{ code, phase, message }` error schema while runtime output restored `kind` and retry policy。
- User-confirmed live manual validation is complete for the release candidate。
