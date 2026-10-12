# Composable Error Handling — Migration Inventory

Status: reviewed

Reviewed: 2026-10-12

## Snapshot

- 26 production files construct CoreOperationError directly。
- 122 direct constructor call sites remain after the foundation was introduced。
- Production presentation has no CDP classification based on message regex or CDP_ prefix。
- Formal Strategy artifacts still persist exact { code, phase, message } records。
- Missing-kind legacy errors remain allowed only before a normalization boundary。

This inventory distinguishes completed vertical-slice migration from reviewed follow-up work. A reviewed deferred module is
not considered normalized；it must continue through the compatibility boundary until migrated。

## Completed in this feature

| Area | Files | Classification／result |
| --- | --- | --- |
| Shared carrier and policies | core/errors.js, core/error-policy.js | Shared contract、bounded traversal、combinators、unknown fallback、safe projection。 |
| CDP source | connection.js | Source normalizer；typed CDP kind、owned deadline、exported target discovery。 |
| Tab target discovery | core/tab.js | Consumer of normalized discovery；no production raw target-list fetch。 |
| Generic artifact output | core/artifacts.js | Source owner；validation／conflict／filesystem split。 |
| Durable Strategy artifacts | core/strategy-run-artifacts.js | Source owner；artifact／conflict／filesystem split，strict persisted schema unchanged。 |
| Strategy compatibility policy | core/strategy-error-policy.js | Domain-owned exact code maps、Run error rehydration、Run／Resume／Extend boundary factory。 |
| Strategy preflight | core/strategy-run.js, core/strategy-extend.js | Aggregated normalized diagnostics and kind-based CDP summary。 |
| Strategy identity | core/strategy-resume.js, core/strategy-run-resolver.js, core/strategy-run-lineage.js | Exact identity translation、source cause preservation、artifact/validation semantics。 |
| Durable cancellation | core/strategy-durable-run-lifecycle.js, core/strategy-run-retry.js | Typed reason preservation、caller cancellation、cascade semantics。 |
| POSIX signals | cli/commands/strategy.js | SIGINT／SIGTERM owner，current operation phase、process_signal stage、130／143。 |
| CLI presentation | cli/router.js | One safe diagnostic projection；fixed 0／1／2／130／143 policy；no message regex。 |
| MCP presentation | tools/_format.js | Same Core projection and additive kind parity。 |
| Selected validation owners | core/studies.js, core/strategy-trading-format.js, selected Strategy Trading validation | Explicit validation／identity／filesystem kinds at public entrypoints。 |

## Reviewed deferred groups

| Group | Files／examples | Current migration state | Follow-up boundary |
| --- | --- | --- | --- |
| Strategy trading runtime | strategy-runtime.js, remaining strategy-trading.js, strategy-trading-model.js, strategy-reconciliation.js | Stable codes reviewed；many internal constructors still omit kind。 | Migrate by Report／Data／Export vertical slices using Strategy exact maps。 |
| Chart ownership | chart-session.js, chart.js, remaining pane.js | Stable validation／identity codes reviewed；Pane CDP prefix heuristic removed。 | Migrate Chart Session as one bounded ownership slice。 |
| Durable state internals | strategy-run-state.js, strategy-run-lease.js, strategy-durable-experiment.js | Persisted projection remains authoritative；runtime helpers partly legacy。 | Migrate by state／lease／experiment groups without changing artifact schemas。 |
| Watchlist | remaining watchlist.js helpers | Signal propagation path reviewed；snapshot and validation helpers still partly legacy。 | Migrate snapshot provider and Symbol validation separately。 |
| Pine／schema | pine-input-schema.js, Pine command errors | Local structured errors reviewed；not required for the motivating Strategy Extension path。 | Add a Pine-owned exact code map before constructor strict mode。 |
| Other MCP tools | Direct jsonResult({ error }) adapters | They do not use the shared Core error carrier yet。 | Convert per tool family；do not route arbitrary tool result data through Core classification。 |
| CLI non-Strategy validation | Plain Error command guards | Unknown fallback now exposes bounded root message as internal。 | Add command-owned validation codes/kinds per command family。 |

## Compatibility gates

1. New or migrated error constructors must supply explicit kind。
2. toCoreDiagnostic() rejects missing-kind legacy errors。
3. Presentation adapters normalize before projection and never inspect message text。
4. Domain translation and persisted rehydration use exact code maps only。
5. Deferred modules must remain listed here until their bounded migration lands。
6. Constructor-wide required kind can be enabled only after the deferred list reaches zero。

## Regeneration commands

~~~sh
rg -n "new CoreOperationError" src --glob '*.js'
rg -n "startsWith\(['\"]CDP_|/CDP|ECONNREFUSED|not running|connection/i" src --glob '*.js'
rg -n "function [A-Za-z0-9_]*(Error|Diagnostic)|function diagnostic" src/core src/cli src/tools --glob '*.js'
~~~
