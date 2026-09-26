---
id: TASK-004
title: Run Config, Resource Resolution, and Dry-run
status: done
phase: strategy-automation-run
depends_on:
  - TASK-001
  - TASK-002
  - TASK-003
blocks:
  - TASK-005
  - TASK-006
  - TASK-007
scope: strategy-run-preflight
---

# TASK-004: Run Config, Resource Resolution, and Dry-run

## Goal

交付versioned Run Config loader、exact-name TradingView resource resolver與完整read-only`strategy run --config ... --dry-run`，在任何mutation前聚合所有可檢查的config、source、resource、Watchlist及Parameter Set errors。

## Requirements

### In scope

- Strict JSON schema version 1與unknown-field rejection。
- Config-relative Pine／output paths、Pine readability與output collision check。
- Optional／generated path-safeRun ID與uniqueParameter Set names。
- Exact Layout name → unique open Tab／runtime IDs／Pane resolution。
- Exact Watchlist name → complete Snapshot。
- Exact Saved Strategy name → Account script與Pane Instances inventory。
- Normalize Account／local source comparison與create／update／reuse plan。
- Current／Candidate Input Schema diff與全部Parameter Sets validation。
- Aggregated errors、warnings與blocked dependent checks。
- `strategy run --config --dry-run`CLI、help、JSON／exit contract。

### Out of scope

- Account create／update、Pane refresh、Input mutation或Trading export。
- Config overrides via CLI flags。
- Retry／resume fields或behavior。
- High-level MCP run tool。

### References

- [`Run Configuration`](./RUN_CONFIGURATION.md)
- [`LLD Run Config`](./LLD.md#run-config-schema-v1)
- TASK-001～003 public Core contracts。

## Design

新增pure`strategy-run-config.js`與read-only`strategy-run-resolver.js`。Resolver只以names接收User intent，回傳完整IDs與match evidence。Dry-run建立plan但不呼叫任何mutation provider；dependent stage prerequisite失敗時標記blocked，其他獨立checks繼續，以一次response呈現可修正問題。

Dry-run完整取得Watchlist Snapshot但stdout只顯示count、fingerprint與bounded samples。Create plan允許不存在的Account name；duplicate names或同一script在Pane多個Instances是blocking errors。

## Verification and Delivery

### Tests

- Schema version、unknown／missing fields、types與path traversal／collision。
- Config-directory-relative paths與generated／explicitRun IDs。
- Layout absent／duplicate／unique open Tab及Pane range。
- Watchlist／Strategy absent、duplicate與Pane zero／one／multiple matches。
- Hash equal／different的reuse／update plan與missing create plan。
- Candidate schema／Parameter Sets valid／invalid aggregation。
- Dry-run零mutation assertions、bounded output、exit 0／1／2。

### Acceptance criteria

- [x] 一份合法config可解析出完整requested／resolved plan。
- [x] User不需提供TradingView IDs。
- [x] 所有read-only可偵測問題在dry-run回傳；不只first error。
- [x] Dry-run不改變Account、Pane、Watchlist、Symbol、Timeframe或filesystem artifacts。
- [x] Formal run可以重用相同loader／resolver，不需重寫validation。

### Validation commands

```bash
fnm exec --using=22 npm run lint
fnm exec --using=22 npm run test:unit
fnm exec --using=22 npm run test:cli
fnm exec --using=22 npm run tv -- strategy run --config ./run-config.json --dry-run
```

### Deliverables

- Config／resolver modules、dry-run application path、CLI contract、example config、tests與manual evidence。

## Completion record

Completed on 2026-09-16.

Implemented:

- Strict Run Config v1 loader with unknown-field rejection, config-relative paths, normalized Pine SHA-256, generated／explicit path-safe Run IDs, output collision checks, and aggregated diagnostics.
- Exact-name open Layout／Tab／Pane, named Account Watchlist, Saved Strategy, and Pane Strategy Instance resolution without visual Tab or Pane activation.
- Candidate／current Input Schema comparison, create／update／reuse and add／refresh／reuse planning, plus exact-title Candidate／Runtime Parameter Set validation.
- `strategy run --config <path> --dry-run`; formal execution remains an explicit `STRATEGY_RUN_NOT_IMPLEMENTED` boundary for TASK-005～007.
- Bounded Watchlist summary, example config, public Core exports, CLI help／exit behavior, and deterministic unit coverage.

Live evidence using Desktop 3.4.0:

- Config: `run-config.example.json`; Layout `dev`; Pane 0; Saved Strategy `obv-v3`; Watchlist `dev-testing-list`.
- Resolved Layout IDs `aQoXnpKX`／`201414175`, Pane ID `1`, Symbol `TWSE_DLY:2330`, Timeframe `1D`.
- Local and Account normalized source hashes matched; Account and Pane actions both resolved to `reuse`; Pane version read back as `3.0`.
- Complete Watchlist Snapshot contained 448 declared／returned／unique Symbols with zero invalid or duplicate Symbols.
- Candidate schema contained 16 Inputs; Desktop runtime catalog contained 35 user-facing Inputs after hidden fields were excluded, and resolved exact titles to `in_3` and `in_7` for the non-empty validation Parameter Set.
- Follow-up correctness hardening rejects empty／incomplete Runtime Catalogs when Candidate Inputs exist, blocks unknown Account／Pane versions, uses exact Account Script ID matching, limits schema diff fields to type／default／min／max, and fingerprints complete Effective Inputs without printing the complete catalog. Explicit `run: null` remains the supported auto-ID form.
- Final response: `success: true`, `valid: true`, `blocked: []`, `warnings: []`, `errors: []`.
- The dry-run did not create output directories or files and did not update Pine, inputs, Pane, Symbol, Timeframe, Layout, or Watchlist state.

Validation:

- `fnm exec --using=22 npm run lint` — 0 errors; 3 pre-existing warnings outside this task.
- `fnm exec --using=22 npm run test:unit` — 482 passed.
- `fnm exec --using=22 npm run test:cli` — 31 passed.
- Live `strategy run --config changes/20260915_strategy_automation_run/run-config.example.json --dry-run` — exit 0.
