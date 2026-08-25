---
id: TASK-006
title: Active Pane Study list and get
status: done
phase: study-strategy-cli
depends_on:
  - TASK-001
  - TASK-002
blocks:
  - TASK-007
  - TASK-008
  - TASK-009
scope: active-pane
---

# TASK-006: Active Pane Study list and get

## Goal

以 `entity_id` 提供 Active Pane Study Instances 的 List 與 Get vertical slice，成為所有 Pane Mutations 與 Strategy Selection 的可信任 read model。

## Requirements

### In scope

- `study list` 與 `--type strategy|indicator|unknown`。
- `study get <entity_id>`，回傳 Metadata、Visibility 與安全過濾後的 Inputs。
- Strategy optional fields：`report_ready` 與 `is_active_strategy`。
- 驗證 Entity 屬於 Active Pane。
- 保留同名多 Instance 與不同 Inputs。

### Out of scope

- Account Saved Script List。
- Add、Inputs Set、Toggle、Remove 或 Strategy Select。
- 回傳 raw encrypted Inputs 或 TradingView internal objects。

### Constraints and references

- [`Active Pane Study Instances`](../../docs/study_strategy_cli_design.md#active-pane-study-instances)
- [`LLD resource model`](./LLD.md#resource-model)
- TASK-002 shared Study response contract。

## Design

List 與 Get 使用同一 Active Pane snapshot 與 normalizer。Get 在 snapshot 中定位 Entity 後才讀取詳細 Inputs；其他 Pane 或 Unknown Entity 使用不同 error code。

## Verification and Delivery

### Tests

- Empty Pane、mixed types、same-name instances、hidden study 與 unknown metadata tests。
- Wrong Pane、Unknown Entity、filtered inputs 與 report-ready tests。
- CLI／MCP List/Get parity tests。

### Acceptance criteria

- [x] Active Pane 所有 Study Instances 可完整列出並依 Type Filter。
- [x] `study get` 以 `entity_id` 精確取得單一 Instance。
- [x] Entity 不在 Active Pane 時不會誤讀其他 Pane。
- [x] Sensitive／encoded Inputs 不出現在 response。
- [x] List 與 `state.studies[]` 使用一致 type semantics。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run tv -- study list
```

### Deliverables

- Active Pane Study List/Get Core、CLI、MCP、safe input filtering、tests 與 command documentation。

## Completion record

- Completed: 2026-08-21.
- Implementation: added `study list`／`study get` CLI and `study_list`／`study_get` MCP tools backed by `src/core/studies.js` and the shared TASK-002 state model.
- Automated validation: Study Catalog／Pane／Pine／CLI targeted tests passed `33/33`; additional Study tests passed `12/12`; lint completed with no errors and four pre-existing warnings.
- Live validation: Active Pane List returned two Strategies from six Studies; Get returned the selected Strategy and 39 public Inputs after filtering `pineId`、`pineVersion`、`pineFeatures` and `__profile` internal metadata.
- Ownership: Get rejects an Entity not present in the Active Pane snapshot before evaluating detail APIs.
