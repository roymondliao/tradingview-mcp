---
id: TASK-009
title: Account Pine, Watchlist and Alert checks
status: todo
phase: desktop-version-compatibility
depends_on:
  - TASK-005
  - TASK-006
blocks:
  - TASK-013
scope: feature-account-services
---

# TASK-009: Account Pine, Watchlist and Alert checks

## Goal

在 Desktop 已登入的前提下，驗證帳號 Pine/Watchlist/Alert 的實際 API 契約，與圖表 runtime checks 分開回報。

## Dependencies and ownership

依賴：[TASK-005](./TASK-005-controlled-fixture-restore-promotion.md)、[TASK-006](./TASK-006-cdp-target-context-checks.md)。

本任務擁有的 Desktop check IDs：`PINE-ACCOUNT-001`、`WATCHLIST-001`、`ALERT-001`。每個 check 的 read-only／controlled assertions 都在本任務交付（ENV 僅 metadata/preflight）。

遵循 [README 檢測清單](./README.md#required-validation-matrix)、[System Design](./SYSTEM_DESIGN.md)、[LLD](./LLD.md) 與 [共用交付規則](./README.md#task-delivery-contract)。

## Requirements

### In scope

- List Saved Pine、Watchlists、Alerts；檢查 response business status/schema/IDs，分清合法空清單與登入頁/error object。
- Known Pine version/source capability、完整 named Watchlist detail/ordered symbols/count/fingerprint、Alert fields 按 fixture 驗證。
- Controlled Pine saveNew/saveNext/readback/delete 僅使用本輪建立的 Script；Watchlist add/remove 僅允許明確指定可修改的測試清單並恢復。
- Controlled disposable Alert create/list/delete；條件避開觸發，無法抑制通知時依既有設計標 blocked，不任意修改既有 Alerts。
- 登入/網路/entitlement、fixture 缺失與 remote service contract failure 分開；failure_origin 與 version_relation 不自動歸因 Desktop 升版。
- 沿用 shared effect/cleanup ledger；不提取 cookie/token、不保存 private source 或完整帳號 inventory。

### Out of scope

- 不重新登入、不管理 credentials、不要求先有 Strategy Report、不用 virtualized DOM rows 當完整 Watchlist。

## Design and deliverables

預計修改／新增：compatibility probes；src/core/pine.js、watchlist.js、alerts.js 的 account/page-context adapters。

Account list 只依賴有效頁面與登入，Strategy failure 不應阻止它。Fixture 不存在時 inventory assertion 可 pass，detail/mutation 仍 blocked，不能以空清單讓整項 pass。

Deliverables：上述實作、必要 fixtures/tests、registry/CLI wiring（適用時）與 completion evidence；不得只新增 stub 或只寫設計文件就標 done。

## Verification and Delivery

### Tests

- Logged-in empty/nonempty、auth expired、HTTP success with error body、shape change、ID/version mismatch。
- Complete Watchlist vs virtualized rows、symbol identity、mutation readback/restore、Pine source hash only。
- Test-owned cleanup、Alert notification precondition、timeout/remote outage 不誤判版本歸因。

### Acceptance criteria

- [ ] 三個 Account checks 獨立回報，沒有使用未實際呼叫的 _alertService 作替代證明。
- [ ] Read-only 不開面板或改帳號資產；必要的 UI add flow 僅 controlled。
- [ ] 所有 mutation 有可驗證 ownership 與 cleanup/restore。

### Validation commands

以下是任務實作後的 target commands；新增 test files 需同步加入實際測試入口。目前不宣稱檔案或測試已存在。

```bash
fnm exec --using=22 node --test tests/compatibility_account_checks.test.js tests/pine_account.test.js tests/watchlist_snapshot.test.js
fnm exec --using=22 npm run lint
git diff --check
```

Live 驗證透過明確呼叫 `tv compatibility check --profile read-only --fixture <fixture.json>` 與 `--profile controlled` 執行；Replay 依契約加 opt-in。其他尚未實作的 checks 必須仍顯示 not_run，本任務可交付自己的 component evidence，但不能因此宣稱整體 passed。

## Completion record

Not started. 任務拆分完成不代表 runtime implementation 或 Live certification 完成。
