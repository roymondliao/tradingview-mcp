---
id: TASK-011
title: Study and Strategy regression and delivery gate
status: done
phase: study-strategy-cli
depends_on:
  - TASK-004
  - TASK-007
  - TASK-008
  - TASK-010
blocks: []
scope: local
---

# TASK-011: Study and Strategy regression and delivery gate

## Goal

整合並驗證 Account Pine、Study Instance 與 Strategy Data vertical slices 可在同一 CLI／MCP Server 中共同運作，完成 compatibility、documentation 與安全 Live Smoke evidence，但不在 Gate 補實作缺少功能。

## Requirements

### In scope

- 稽核所有 Commands／Tools 已由正式 CLI Router 與 MCP Server 註冊。
- 驗證 CLI／MCP 共用 Core Functions、ID semantics、Type／Source vocabulary 與 error codes。
- 執行完整 deterministic Unit、CLI、Lint 與 safe Full Test Suite；會清除 drawings、覆寫 Pine Editor 或切換 Replay 的 legacy E2E 保留為明確 opt-in `test:e2e`。
- 使用已登入 TradingView Desktop 執行 read-only smoke，以及只操作本次建立 disposable resources 的 mutation smoke。
- 更新 README Task Table、Feature Status、Design status、Terminology 與 command reference。
- 記錄 Node／TradingView Desktop／Electron／Chrome versions 與 validation results。

### Out of scope

- 補實作任何未完成 Feature；缺口退回 owner Task。
- Watchlist batch、Trade Offset/Snapshot Pagination 或公開 Pine Publish。
- 刪除或修改既有使用者 Saved Scripts／Study Instances 作為測試捷徑。

### Constraints and references

- [`Feature exit criteria`](./README.md#exit-criteria)
- [`LLD testing model`](./LLD.md#testing-model)
- [`CLI command check`](../../docs/cmd_check.json)

## Design

Gate 使用 repository 正式 commands 與 deterministic fixtures 重跑各 Task assertions，不建立第二套 implementation。Live Smoke 建立唯一 disposable Script／Instance，記錄 IDs，逐步 readback，最後只清理由本次 run 建立且已驗證 ownership 的 resources。

## Verification and Delivery

### Tests

- 完整 unit／CLI／full regression suites 與 lint。
- CLI help／MCP registration inventory、legacy aliases、error-contract 與 no-hanging-process checks。
- Account List → Study Add → Inputs Set → Strategy Select → Report Read → Study Remove 的代表性 Live Smoke。
- Destructive cleanup ownership guard 與 interrupted-run recovery validation。

### Acceptance criteria

- [x] TASK-001～010 全部為 terminal `done`，沒有未引用 implementation 或 blocking question。
- [x] CLI 與 MCP command inventory、payloads、errors 與 compatibility policy 一致。
- [x] Unit、CLI、Lint 與 safe Full Test Suite 全部通過。
- [x] Runtime timeout baseline 不再出現只有 npm banner、無 JSON 的永久等待。
- [x] Live Smoke 沒有修改或刪除既有使用者 resources。
- [x] README、LLD、Design、Terminology 與實際 CLI behavior 一致。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run test:all
npm run tv -- --help
npm run tv -- state
npm run tv -- pine list --type strategy
npm run tv -- study list
npm run tv -- strategy --help
```

### Deliverables

- Regression result、command/tool inventory、compatibility audit、safe Live Smoke record、updated documentation 與 Feature Completion Record。

## Completion record

- Completion date: 2026-08-22.
- Dependency audit: TASK-001～010 are `done`; Community Search／Add was explicitly moved to deferred scope by product decision.
- Automated validation: `npm run test:all` passed `243/243`; `npm run test:cli` passed `17/17`; MCP registration inventory passed; lint reported zero errors and four pre-existing warnings; `git diff --check` passed.
- Live TradingView environment: macOS, Node `v26.5.1`, TradingView Desktop `3.3.0` build `3.3.0.7992`, Electron `38.2.2`, Chrome `140.0.7339.133`, CDP protocol `1.3`.
- Live read-only validation: Active Target `i3c6QVMw`, `TWSE_DLY:2388` `1D`; Built-in／Account searches, Study list/get, active Strategy `mKPazw`, Report, Orders, paired Trades and explicit unavailable Equity contract passed.
- Disposable resource cleanup: Built-in RSI Entity `LXELUx` and Account Bias Ratio Entity `aeZuia` were created, read back and removed by exact ID. Bias Ratio input `in_1` was set to its existing value `5` and confirmed under `unchanged_inputs`. Final Active Pane count returned to six; no Saved Pine Script was updated or deleted.
- Live-gate correction: `Script$STD;...` source classification was corrected to `built-in`; compact Trade metrics `{v,p}` now normalize to `{value,percent}`; Order `e/tm` now expose `is_entry/time_index`.
- Compatibility and documentation audit: CLI/MCP share Core implementations; legacy Strategy Data aliases reject missing `entity_id`; `test:all` is safe/deterministic and destructive legacy coverage remains explicit under `test:e2e`.
- 2026-08-25 selector/history regression: `test:all` passed `256/256`, CLI tests passed `19/19`, lint reported zero errors and three pre-existing warnings, and `git diff --check` passed. Live read-only checks resolved active Layout `dev` and background Layout `Short-Strategy` independently by `layout_id`; renamed History fields returned `bars_per_request`, `requests_made`, `max_requests`, and `max_bars`.
- 2026-08-25 time contract: preserve Unix timestamp fields and add UTC ISO 8601 companion fields (`*_iso`) across market-data, chart-range, Strategy, Saved Pine metadata, alert, drawing, layout, and stream responses. Logical indexes remain unchanged.
