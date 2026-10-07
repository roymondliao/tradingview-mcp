# Strategy Run Schema Naming — Delivery Evidence

Completed: 2026-10-07

## Delivered behavior

- New `strategy run` writes formal artifact v3:
  - root `artifact_schema_version: 3`
  - `run.json.requested.config_schema_version: 1`
- `experiment.json` and Experiment `manifest.json` use the same v3 root field。
- Readers accept strict legacy v2 and current v3 contracts。
- Transitions and durable writes preserve the loaded artifact family。
- Mixed v2／v3 Run trees、dual version fields、missing discriminators and unknown versions are rejected。
- User-facing Run Config v1、Trading Export v1、Watchlist validation and downstream trading schemas are unchanged。

## Automated validation

### Supported Node runtime

```text
fnm exec --using=22.19.0 npm run test:unit
673 tests passed, 0 failed
```

```text
fnm exec --using=22.19.0 npm run test:durable
117 tests passed, 0 failed
```

The durable suite includes:

- v3 new-write exact-shape assertions。
- Legacy v2 tree loading。
- Mixed-family rejection。
- Full legacy v2 Resume execution followed by persisted v2 shape verification。
- Atomic write and fault-matrix coverage。
- 652 × 3 durable benchmark harness coverage。

### Lint and whitespace

```text
npm run lint
0 errors; 3 pre-existing unused-variable warnings outside this Change
```

```text
git diff --check
passed
```

## Environment-limited validation

`npm test` requires a live TradingView Desktop CDP environment, exact Layout `dev` and Account Watchlist `dev-testing-list`. The local preflight was not ready, so the live E2E suite was cancelled before executing mutations. Offline `pine_analyze` tests in the same command passed. No live TradingView acceptance was required for this local schema-only change。
