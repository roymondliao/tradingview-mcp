---
id: TASK-002
title: Study domain model and Chart State
status: done
phase: study-strategy-cli
depends_on:
  - TASK-001
blocks:
  - TASK-003
  - TASK-005
  - TASK-006
scope: local
---

# TASK-002: Study domain model and Chart State

## Goal

建立單一 Study Type Classifier 與 Instance response contract，並讓 `state.studies[]` 能辨識 Strategy、Indicator 與 Unknown。

## Requirements

### In scope

- 集中處理 `isTVScriptStrategy`、`is_strategy`、`reportData()` 與其他可靠 metadata。
- 定義 `entity_id`、`name`、`type`、`visible` 與 optional source/report fields。
- 擴充 `npm run tv -- state` 與 `chart_get_state` MCP response。
- 同名 Instances 保留各自 Entity ID。
- 定義既有 `studies[].id` 的 compatibility behavior。

### Out of scope

- Account Script List、Study Add／Remove 或 Strategy Selection。
- 在 `state` 回傳完整 Pine Source、完整 Inputs 或 raw TradingView objects。
- Metadata 不足時猜測 Indicator。

### Constraints and references

- [`Terminology`](../../docs/terminology.md)
- [`Chart state design`](../../docs/study_strategy_cli_design.md#chart-state)
- [`LLD resource model`](./LLD.md#resource-model)

## Design

Classifier 與 normalizer 由 Chart State、Study List 與 Strategy operations 共用。`unknown` 是正式 type，不是 error。State 保持摘要輸出；敏感或大型欄位由後續 Get command 取得。

## Verification and Delivery

### Tests

- Strategy、Indicator、Unknown、缺少 metadata 與 fallback classification tests。
- 同名多 Instance、hidden study 與 report-ready normalization tests。
- CLI／MCP State contract 與 legacy `id` compatibility tests。

### Acceptance criteria

- [x] 每筆 `state.studies[]` 具有 `entity_id`、`name`、`type` 與 `visible`。
- [x] Strategy、Indicator 與 Unknown 均能被 deterministic tests 覆蓋。
- [x] Classification logic 沒有分散複製於多個 Core modules。
- [x] 同名 Instances 不會被合併或覆蓋。
- [x] CLI 與 MCP 回傳同一 normalized contract。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run tv -- state
```

### Deliverables

- Shared Study classifier／normalizer、擴充的 Chart State Core／CLI／MCP、compatibility policy 與 tests。

## Completion record

- Completed: 2026-08-21.
- Implementation: shared classifier and page helpers live in `src/core/studies.js`; Chart State delegates to the shared Active Pane state adapter; Strategy discovery reuses the same classifier.
- Automated validation: targeted Study／Chart／CLI tests passed `22/22`; lint completed with no errors and four pre-existing warnings.
- Live validation: Active Pane returned two Strategies and four Indicators with `entity_id`、`type`、`visible`; the visible Strategy reported `report_ready: true`, while the hidden Strategy reported `false`.
- Compatibility: legacy `studies[].id` remains alongside canonical `entity_id` during migration.
