---
id: TASK-005
title: Study Catalog search
status: done
phase: study-strategy-cli
depends_on:
  - TASK-001
  - TASK-002
blocks:
  - TASK-007
scope: active-pane
---

# TASK-005: Study Catalog search

## Goal

提供不修改 Pane 的 Study Search vertical slice，辨識 Built-in 與 Account Sources，並為後續 Add 提供足夠識別資訊。

## Requirements

### In scope

- `study search <query>` CLI、MCP 與 shared Core。
- `--source built-in|account` 與 `--type strategy|indicator|unknown`。
- Account／Built-in stable metadata、Localization 與 duplicate title handling。
- 回傳 Title、Source、Type 與可用 stable identifier。
- 沒有 stable ID 時明確標示 Query-based Add constraints。

### Out of scope

- Search 時自動將 Result 加入 Pane。
- 宣稱能一次列出 TradingView 全部 Catalog。
- 以第一筆 partial match 靜默解決 ambiguous result。
- Community Script Search；保留為後續擴充需求。

### Constraints and references

- [`Study catalog and search`](../../docs/study_strategy_cli_design.md#study-catalog-and-search)
- [`LLD command ownership`](./LLD.md#command-ownership)
- Existing search implementation: `src/core/indicators.js`

## Design

Search 與 Add 分離。Account 使用 Saved Pine metadata；Built-in 使用 Pine Facade standard catalog 與穩定 `STD;...` identifier。同名多結果全部保留，由 Add 層拒絕 ambiguous query。

## Verification and Delivery

### Tests

- Built-in、Account、Unknown Type 與 localized title tests。
- Duplicate titles、no result、API failure 與 timeout tests。
- Search read-only guarantee、CLI／MCP filter contract tests。

### Acceptance criteria

- [x] Search 支援 Source 與 Type Filters。
- [x] Duplicate Titles 不會被合併或任意選取。
- [x] Type 或 Source 不確定時回傳 Unknown，而非錯誤猜測。
- [x] Search 不修改 Active Pane Study Count。
- [x] CLI 與 MCP 使用相同 Search Result contract。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run tv -- study search "Supertrend"
```

### Deliverables

- Study Search Core、CLI、MCP、Catalog result normalizer、filters、tests 與 command documentation。

## Completion record

- Completed: 2026-08-22.
- Scope decision: Community Search was moved to a future feature; this Task supports Account + Built-in catalogs.
- Implementation: Account search reads Saved Pine metadata; Built-in search reads the standard catalog and returns stable `STD;...` IDs without opening Indicators Dialog.
- Live validation: `study search Supertrend --source built-in` returned two typed Built-in results; Account Strategy filtering was previously validated. Search performs no Pane mutation.
