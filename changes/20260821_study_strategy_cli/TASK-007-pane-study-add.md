---
id: TASK-007
title: Add Study to Active Pane
status: done
phase: study-strategy-cli
depends_on:
  - TASK-003
  - TASK-005
  - TASK-006
blocks:
  - TASK-011
scope: active-pane
---

# TASK-007: Add Study to Active Pane

## Goal

將 Account 或 Built-in Study Definition 加入 Active Pane，並以 mutation diff 與 readback 回傳唯一的新 Study Instance。

## Requirements

### In scope

- `study add --script-id <script_id>`。
- 可取得穩定 ID 時支援 `study add --study-id <study_id>`。
- `study add --query <query>`，並支援 Source／Type disambiguation。
- Add 前後比較 Active Pane Entity IDs。
- 驗證新增 Instance 的 Name、Type、Source 與 Pane ownership。
- 可選初始 Inputs，在 Add 後套用並讀回。

### Out of scope

- 建立 Account Pine Script。
- Ambiguous Query 時任意加入第一筆 Result。
- 修改其他 Pane 或刪除既有 Instance。
- Community Script Add；保留為後續擴充需求。

### Constraints and references

- [`Study Add design`](../../docs/study_strategy_cli_design.md#add)
- [`LLD mutation rules`](./LLD.md#mutation-and-destructive-operation-rules)
- TASK-003 Account identifiers、TASK-005 Search result、TASK-006 Pane snapshot。

## Design

每種 Add source 最終進入同一 Core mutation pipeline：解析唯一 Definition、取得 before snapshot、執行 Add、等待 Chart Ready、取得 after snapshot、確認唯一新增 Entity，再回傳 normalized Instance。無法唯一辨識時失敗且不執行 mutation。

## Verification and Delivery

### Tests

- Saved Strategy、Saved Indicator、Built-in 與 query-based add tests。
- Ambiguous result、no new entity、multiple new entities、timeout 與 readback mismatch tests。
- Initial Inputs success／unknown keys 與 CLI／MCP parity tests。

### Acceptance criteria

- [x] Add 成功回傳唯一 `entity_id`、Name、Type 與 Source。
- [x] 新增 Instance 確認位於 Active Pane。
- [x] Ambiguous Query 不會改變 Pane。
- [x] Initial Inputs 只回報實際 readback confirmed values。
- [x] Mutation 或 readback failure 不回傳假成功。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run test:all
```

### Deliverables

- Study Add Core、CLI、MCP、source adapters、disambiguation、mutation verification、tests 與 documentation。

## Completion record

- Completed: 2026-08-22.
- Scope decision: Community Add was moved to a future feature; this Task supports Account + Built-in Definitions.
- Implementation: explicit `script_id`／`study_id`／unique query resolution, Active Pane before/after diff, Pine descriptor mapping, optional initial Inputs, CLI and MCP entry points.
- Automated validation: Saved Strategy、Saved Indicator、Built-in、ambiguous selector and missing readback tests are covered and passing.
- Live validation and cleanup are recorded in TASK-011.
