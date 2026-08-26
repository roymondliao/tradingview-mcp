---
id: TASK-003
title: Account Saved Pine read operations
status: done
phase: study-strategy-cli
depends_on:
  - TASK-001
  - TASK-002
blocks:
  - TASK-004
  - TASK-007
scope: account
---

# TASK-003: Account Saved Pine read operations

## Goal

以 `script_id` 提供 Account Saved Pine Scripts 的 List 與 Get vertical slice，並能依 Script Type 過濾 Strategy、Indicator、Library 或 Unknown。

## Requirements

### In scope

- `pine list --type strategy|indicator|library|unknown`。
- `pine get --script-id <script_id>` 與對應 MCP tools。
- 保存 Pine Facade 可用的 Type、Version、Modified 與 ownership metadata。
- Metadata 不足時使用可測試的 fallback classification，或明確回傳 Unknown。
- Account List 不混入 Built-in／Community Studies。

### Out of scope

- Create、Update、Delete 或 Add to Pane。
- 列舉 TradingView 全部 Catalog。
- 在預設 List response 回傳完整 private Pine Source。

### Constraints and references

- [`Account-level Saved Pine Scripts`](../../docs/study_strategy_cli_design.md#account-level-saved-pine-scripts)
- [`LLD response contract`](./LLD.md#response-and-error-contract)
- Existing Pine implementation: `src/core/pine.js`

## Design

Account API response 先通過 normalizer，再由 Type Filter 篩選。Get 只接受 `script_id`；Entity ID 必須以 Wrong ID Kind 拒絕。若取得 Source 才能分類，Source 僅存在於 page/core boundary，不寫入 logs 或 List response。

## Verification and Delivery

### Tests

- Empty Account、各 Script Types、Unknown metadata、Unauthorized 與 malformed facade response tests。
- `script_id` validation、Type Filter 與 sensitive-field redaction tests。
- CLI／MCP List/Get contract tests。

### Acceptance criteria

- [x] 可以只列出 Account Saved Strategies、Indicators 或 Libraries。
- [x] 每筆結果至少包含 `script_id`、`name`、`type` 與可用 version metadata。
- [x] `pine get` 不接受 Pane `entity_id`。
- [x] Built-in／Community Results 不會被標記為 Account-owned。
- [x] CLI 與 MCP 共用相同 Core List/Get implementation。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run tv -- pine list --type strategy
```

### Deliverables

- Account Pine List/Get Core、CLI、MCP、type filtering、response schemas、tests 與 command documentation。

## Completion record

- Completed: 2026-08-21.
- Implementation: Pine Facade `extra.kind` maps `strategy` → Strategy、`study` → Indicator、`library` → Library；unknown values remain Unknown. `pine get --script-id` extends the existing editor-source command without breaking its no-option behavior.
- Automated validation: Account Pine／Study／CLI targeted tests passed `25/25`; lint completed with no errors and four pre-existing warnings.
- Live validation: `pine list --type strategy` returned `8` Strategies from `21` Account Scripts; explicit `pine get --script-id` returned the selected Strategy metadata and a 386-line source without printing private source during validation.
- MCP: `pine_list_scripts` accepts an optional Type Filter and `pine_get_script` reads one Account-owned Script.
