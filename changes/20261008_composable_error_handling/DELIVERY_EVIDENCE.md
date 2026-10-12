# Composable Error Handling — Delivery Evidence

Status: automated gates passed；live Desktop checks pending

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
| Node 22 unit suite | 719 passed，0 failed |
| Node 24 unit suite | 719 passed，0 failed |
| Durable suite | 132 passed，0 failed |
| ESLint | 0 errors；3 pre-existing unused-variable warnings |
| Package dry-run | Passed with isolated npm cache；276 files |
| Version synchronization | 1.4.0 synchronized |
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

## Pending live checks

1. Desktop unavailable：run Strategy Extension dry-run against a valid Parent／Config and confirm CDP diagnostic plus exit 2。
2. Desktop available：run the same dry-run and confirm a valid Extension plan or only true resource／identity diagnostics。
3. SIGINT during a formal Run／Extend and Resume：confirm owning phase、process_signal semantics、durable error and exit 130。
4. MCP parity for one live CDP failure：confirm the same code／kind／phase／stage／retryable fields as CLI。
