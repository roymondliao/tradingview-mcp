# Strategy Trading Delivery Evidence

Date: 2026-09-04

## Environment

| Item | Validated value |
| --- | --- |
| TradingView Desktop | 3.4.0 (build 3.4.0.8149) |
| Electron / Chrome | 41.7.1 / 146.0.7680.216 |
| CDP protocol | 1.3 |
| OS / architecture | Darwin 25.6.0 / arm64 |
| Node.js | 22.16.0; CI parity also checked with 24.18.0 |
| Repo commit before gate changes | `b62b64bffad4` |

Desktop version came from the installed app bundle. Electron, Chrome and CDP identities came from the local `/json/version` endpoint. Live commands used an explicit runtime Layout ID and Pane index; private Strategy source, cookies and credentials were not captured.

## Deterministic regression

Final gate commands and results are recorded in [TASK-011](./TASK-011-regression-delivery-gate.md). Coverage includes:

- compact and verbose runtime adapters plus unsupported schemas;
- Desktop CSV 17-semantic mapping and JSON / JSONL / CSV parity;
- Closed, Open and breakeven reconciliation rules;
- multi-Pane context, stale snapshot and deterministic Trade batching;
- staging, atomic publish, overwrite refusal and failure cleanup;
- single-Symbol and Watchlist success, partial failure and fail-fast behavior;
- CLI exit codes, bounded stdout, MCP schemas / forwarding / errors and legacy deprecation.

## Live evidence

### Context and identity

- `tab list` returned three Chart Tabs; all three had `metadata_status: ready`.
- Desktop 3.4.0 resolved runtime `layout_id`, account `saved_layout_id`, Layout name and Pane inventory together.
- The controlled smoke fixed one Layout, Pane index 0 and one explicit Strategy `entity_id` before any Symbol operation.
- `strategy active` returned four Strategies in the Pane, the intended active Strategy, a ready Report and an available snapshot.

### Report and multi-batch Trading Data

- A live `trading-report` for `TWSE:6531 / 1D` returned canonical Report schema v1, context, five reconciliation metrics and a derived SHA-256 snapshot.
- `TWSE:2344 / 1D` exposed 12 oldest-first Trades. Three separate CLI invocations walked offsets `0`, `4` and `8` with limit 4 and the same snapshot ID; report indexes covered 0 through 11 with no gap or duplicate, and the final batch returned `has_more: false`.
- A deliberate continuation attempt against a changed live snapshot returned `STALE_STRATEGY_SNAPSHOT` before returning a mixed batch. This confirms that callers must restart at offset 0 when a Report changes.
- Every invocation restored the original `TWSE_DLY:6531 / 1D` Chart state.

### Single-Symbol export

- `strategy trading-export` exported `TWSE:2344 / 1D` as CSV into a dedicated temporary directory.
- The run atomically published `manifest.json`, `report.json`, `trades.csv` and `reconciliation.json` with no staging residue.
- 12 canonical Trades produced 24 CSV Entry / Exit rows.
- Total net profit, win rate, total Trades, winning Trades and losing Trades all reconciled. Net profit differed by approximately `0.00001 TWD`, below the `0.01 TWD` tolerance.

### Active Watchlist export

- The Active Watchlist snapshot contained 13 Symbols.
- One sequential `strategy trading-export --watchlist active` run completed all 13 Symbols: requested 13, succeeded 13, failed 0, skipped 0.
- All 13 reconciliation artifacts reported success, all Symbol artifact directories were present, and no staging residue remained.
- The workflow restored the original Symbol and timeframe once after the run.
- Final process inspection found no remaining `src/cli/index.js` process. A final `strategy active` readback confirmed the original `TWSE_DLY:6531 / 1D` context remained ready.

## Desktop sample comparison

The deterministic paired fixture derived from `data/trade_data_TWSE_2344.csv` continues to cover the localized Desktop download shape. Runtime fields map to all 17 documented semantic groups without depending on localized headers. The five approved reconciliation metrics match under raw precision / documented tolerance; commission is treated as a fee, and Open Trade mark-to-market P&L is excluded.

## Release decision

The feature adds backward-compatible CLI and MCP capabilities and retains legacy surfaces as explicit deprecated compatibility paths. Per the repository SemVer policy this is a minor release, so the package version advances from `1.1.0` to `1.2.0`. The release workflow remains responsible for creating tag `v1.2.0` after the feature PR is merged into `fork-main` and CI passes.

Successful live artifacts and the isolated npm pack cache were inspected and then removed from `/private/tmp`; they were not committed and are not recoverable.
