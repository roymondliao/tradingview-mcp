---
id: TASK-004
title: Run Config, Resource Resolution, and Dry-run
status: todo
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

- [ ] 一份合法config可解析出完整requested／resolved plan。
- [ ] User不需提供TradingView IDs。
- [ ] 所有read-only可偵測問題在dry-run回傳；不只first error。
- [ ] Dry-run不改變Account、Pane、Watchlist、Symbol、Timeframe或filesystem artifacts。
- [ ] Formal run可以重用相同loader／resolver，不需重寫validation。

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

Not started.

