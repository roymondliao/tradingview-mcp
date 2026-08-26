---
id: TASK-010
title: Strategy data commands
status: done
phase: study-strategy-cli
depends_on:
  - TASK-009
blocks:
  - TASK-011
scope: active-pane
---

# TASK-010: Strategy data commands

## Goal

讓 Report、Orders、Trades 與 Equity 都作用於明確的 Strategy Instance，並移除現有資料介面中 Strategy selection 與 Order/Trade naming 的歧義。

## Requirements

### In scope

- `strategy report <entity_id>`。
- `strategy orders <entity_id>`。
- `strategy trades <entity_id>`。
- `strategy equity <entity_id>`。
- CLI、MCP、Core 與 normalized payloads。
- 重構既有 `data strategy/trades/equity` 的 implicit `findStrategy()` behavior。
- 明確區分 `ordersData()` 原始 Orders 與 Entry／Exit 配對後 Trades。
- 定義 legacy command alias／deprecation policy。

### Out of scope

- Watchlist batch execution。
- 完整 Offset／Snapshot Pagination contract。
- 將 TradingView 未暴露的 Equity data 偽造成完整 curve。

### Constraints and references

- [`Strategy-specific operations`](../../docs/study_strategy_cli_design.md#strategy-specific-operations)
- [`Terminology: Order and Trade`](../../docs/terminology.md)
- TASK-009 selection/readback contract。

## Design

每個 Data Command 先驗證並選擇指定 Strategy，再讀取對應 report source。Orders 保留 TradingView 原始事件語意；Trades 只有在 Entry／Exit 可可靠配對時提供。Legacy `data trades` 不可繼續把 Orders 靜默命名為 Trades。

## Verification and Delivery

### Tests

- Multiple strategies、wrong entity、report pending、orders normalization、trade pairing 與 unavailable equity tests。
- Legacy alias／deprecation、CLI／MCP response parity 與 timeout tests。
- Symbol、Timeframe、Strategy ID tagging tests。

### Acceptance criteria

- [x] 所有 Strategy Data Commands 使用明確 Entity ID。
- [x] Response 包含 Strategy Entity ID、Name、Symbol 與 Timeframe。
- [x] Orders 與 Trades 使用不同 contract，不再混稱。
- [x] 多 Strategy Pane 不會讀取錯誤 Report。
- [x] TradingView 未提供資料時回傳明確 limitation，不偽造成功 payload。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run test:all
```

### Deliverables

- Strategy Report／Orders／Trades／Equity Core、CLI、MCP、legacy compatibility、tests 與 data-contract documentation。

## Completion record

- Completed: 2026-08-21.
- Implementation: added explicit `strategy report`／`orders`／`trades`／`equity` Core, CLI and MCP slices. Every read first selects and confirms the requested Strategy Entity and then revalidates the active source in page context.
- Data contract: Orders normalize raw `ordersData()` events; Trades normalize paired `reportData().trades` entry/exit records with stable `report_index`. Responses carry Entity, Strategy summary, Symbol and Timeframe.
- Compatibility: legacy `data strategy`／`trades`／`equity` commands and MCP aliases now require `entity_id` and delegate to the explicit Strategy Core; implicit first/report-ready selection was removed from the public Data Core.
- Limitations: Equity returns `success: false`, `available: false` and a limitation when the report exposes only a buy-hold baseline. It never substitutes buy-hold data for Strategy equity.
- Automated validation: report tagging, terse/verbose normalization, Orders-vs-Trades separation, result limits and unavailable Equity tests pass. Live data smoke was not run because CDP port `9222` was unavailable.
