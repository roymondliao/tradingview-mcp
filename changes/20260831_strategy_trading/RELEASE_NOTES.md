# Release notes: v1.2.0

## Strategy Trading export

- Adds CLI-first `strategy active`, `strategy trading-report`, `strategy trading-data` and `strategy trading-export` workflows.
- Supports explicit Tab / Layout / Pane / Strategy / Symbol context and restores the original Chart after controlled Symbol changes.
- Retrieves complete, oldest-first Strategy Trading Data with stable snapshot-aware Offset / Limit batching.
- Exports canonical JSON, JSONL or CSV artifacts using staging and atomic publish.
- Exports one Symbol or an immutable Active Watchlist snapshot sequentially, with per-Symbol status and a run manifest.
- Reconciles total net profit, win rate, total Trades, winning Trades and losing Trades before publishing a successful Symbol.
- Preserves Unix millisecond timestamps and includes UTC ISO 8601 companions.

## MCP and compatibility

- Adds `strategy_get_trading_report`, `strategy_get_trading_data` and `strategy_export_trading`; expands `strategy_get_active` with resolved Pane context.
- CLI and MCP use the same Core application services, canonical models and structured errors.
- Keeps legacy Strategy / Data Report and Trades interfaces as deprecated compatibility surfaces. Tail-only responses are not snapshot-complete and must not be treated as full exports.

## Runtime and platform

- Supports Desktop 3.4.0 Layout identity through runtime `_saveChartService.layoutId()` and maps the separate account Saved Layout storage ID.
- Requires Node.js 22 or newer; CI validates Node.js 22 and 24.

## Upgrade notes

- Use an explicit Strategy `entity_id` and `exchange:symbol` identity for Report and Trading Data requests.
- Use `strategy trading-export` for complete files; `strategy trading-data` without `--output` intentionally returns one bounded batch.
- Existing output targets are not overwritten unless `--force` is supplied.
- A stale snapshot is a retryable failure: restart retrieval from offset 0 rather than appending to previously fetched batches.
