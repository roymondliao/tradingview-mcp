---
id: TASK-010
title: MCP parity and Strategy compatibility
status: done
phase: strategy-trading
depends_on:
  - TASK-005
  - TASK-006
  - TASK-009
blocks:
  - TASK-011
scope: local
---

# TASK-010: MCP parity and Strategy compatibility

## Goal

在CLI contracts穩定後提供同Core functions的MCP parity，並完成舊Strategy／Data commands與tools的deprecation、alias或removal處理，避免兩套domain workflow。

## Requirements

### In scope

- 新增Active、Trading Report、Trading Data與Trading Export MCP schemas／handlers。
- MCP使用與CLI相同required fields、snapshot、format、errors與application services。
- 大型Trading Data預設回batch或artifact summary，不塞入完整Watchlist payload。
- 處理既有`strategy select/report/trades`與`data strategy/trades`compatibility。
- 更新server tool guide、registration inventory與command/tool mapping docs。

### Out of scope

- MCP專屬orchestration或不同reconciliation rules。
- Remote filesystem、async job queue或parallel Symbols。
- 擴充Orders／Equity功能。

### Constraints and references

- [`CLI and MCP ownership`](./LLD.md#cli-and-mcp-ownership)
- TASK-001 compatibility decision與TASK-005／006／009 Core APIs。

## Design

Tools只做Zod validation與`jsonResult`formatting，直接呼叫`strategy-trading.js`。Legacy paths不得重新採用implicit first Strategy或tail-only結果冒充complete data。

## Verification and Delivery

### Tests

- MCP tool registration inventory與schema fields。
- CLI／MCP same-input Core response parity。
- Domain error code與isError mapping。
- Large output returns summary／paths。
- Legacy alias／deprecation deterministic behavior。

### Acceptance criteria

- [x] CLI與MCP沒有重複Trading workflow implementation。
- [x] MCP要求明確entity、symbol與Pane context。
- [x] Snapshot、format與error semantics與CLI一致。
- [x] Legacy behavior有文件與tests，不靜默破壞資料正確性。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run test:all
```

### Deliverables

- MCP tools、compatibility layer、registration／parity tests、server guide與documentation。

## Completion record

Completed on 2026-09-04.

- 新增`strategy_get_trading_report`、`strategy_get_trading_data`與`strategy_export_trading`，並擴充`strategy_get_active`回傳固定Pane context。
- MCP handlers只負責schema validation、context resolution與response formatting；Report、Trade batching、artifact與Watchlist export皆直接使用`strategy-trading.js` Core services。
- `strategy_get_trading_data`可回傳單一bounded batch，或透過`output`寫入JSON／JSONL／CSV後只回artifact summary；Watchlist export只回run／per-Symbol summary與paths。
- Core errors保留穩定`code`、`phase`、Strategy／Symbol、retryability與safe context，MCP failure同時標記`isError: true`。
- 舊`strategy_select`、`strategy_get_report`、`strategy_get_trades`及Data aliases保留為明確deprecated compatibility tools；tail-only資料回應標記`snapshot_complete: false`。
- Registration、schema、Core forwarding、bounded output、partial failure、error mapping與legacy behavior已有deterministic tests。

Validation：

- `npm run test:unit`：398 passed。
- `npm run test:cli`：26 passed。
- `npm run test:all`：398 passed。
- `npm run lint`：0 errors；3個既有unused-variable warnings。
