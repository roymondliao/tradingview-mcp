---
id: TASK-004
title: Account Saved Pine write operations
status: done
phase: study-strategy-cli
depends_on:
  - TASK-003
blocks:
  - TASK-011
scope: account
---

# TASK-004: Account Saved Pine write operations

## Goal

提供 Account-owned Saved Pine Script 的 Create、Update 與 Delete vertical slice，並以 ownership、confirmation 與 readback 保護寫入操作。

## Requirements

### In scope

- `pine create --type strategy|indicator|library`。
- `pine update --script-id <script_id>`，並定義 Name／Source／Version 可更新範圍。
- `pine delete --script-id <script_id>`，支援互動確認與非互動 `--yes`。
- Create／Update 後讀回 Metadata，Delete 後確認 Script 不存在。
- CLI、MCP、Core 與 tests 同步交付。

### Out of scope

- 刪除 Built-in、Community Script 或 Pane Study Instance。
- Publish Public／Invite-only TradingView Script。
- 未驗證 ownership 的 Delete。

### Constraints and references

- [`Account Create and Delete design`](../../docs/study_strategy_cli_design.md#account-level-saved-pine-scripts)
- [`LLD destructive-operation rules`](./LLD.md#mutation-and-destructive-operation-rules)
- TASK-003 Account ownership contract。

## Design

Write operations 使用 Account Get 驗證目標與 ownership。Mutation success 只在 readback confirmation 後建立。Delete 預設拒絕非互動執行，除非明確傳入 `--yes`；Live test 只操作本次建立的 disposable Script。

## Verification and Delivery

### Tests

- Create／Update／Delete success、API failure、readback mismatch 與 unauthorized tests。
- Missing confirmation、Wrong ID Kind、not-owned 與 nonexistent Script tests。
- CLI prompt／`--yes`／exit-code 與 MCP explicit confirmation contract tests。

### Acceptance criteria

- [x] Create 回傳新的 `script_id`、Type 與 Version。
- [x] Update 讀回並確認實際保存內容或 metadata。
- [x] 未確認的 Delete 不改變 Account 資料。
- [x] Built-in、Community 與 not-owned resources 不能被 Delete。
- [x] Write failure 或 readback mismatch 不回傳假成功。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run test:all
```

### Deliverables

- Account Pine Create／Update／Delete Core、CLI、MCP、confirmation／readback safeguards、tests 與 destructive-operation documentation。

## Completion record

- Completed: 2026-08-21.
- Implementation: added `pine create`／`update`／`delete`, corresponding MCP tools, Pine declaration type validation, `pineLibApi().saveNew/saveNext`, authenticated delete adapter, bounded list/source readback and CRLF/LF normalization.
- Destructive safeguards: Delete accepts only an Account `USER;...` resource confirmed by Account Get; CLI requires an interactive `yes` or `--yes`, MCP requires literal `confirm: true`, and success requires absence in Account List readback.
- Compile behavior: TradingView can persist a version even when compilation fails. The response therefore reports `success: false`, `saved: true`, compile diagnostics and a revert hint instead of claiming rollback.
- Automated validation: create/update/delete, ownership, confirmation, compile-failure and readback-mismatch deterministic tests pass. Live create/delete was not run because TradingView Desktop CDP port `9222` was unavailable; no Account resource was mutated.
