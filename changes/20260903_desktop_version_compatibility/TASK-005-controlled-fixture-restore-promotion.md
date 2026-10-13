---
id: TASK-005
title: Controlled fixture, restore and state promotion coordinator
status: todo
phase: desktop-version-compatibility
depends_on:
  - TASK-001
  - TASK-004
blocks:
  - TASK-006
  - TASK-007
  - TASK-008
  - TASK-009
  - TASK-010
  - TASK-011
  - TASK-012
scope: controlled-framework
---

# TASK-005: Controlled fixture, restore and state promotion coordinator

## Goal

讓 controlled checks 在明確 fixture、固定 context 與有界恢復機制下執行，只有完整真實證據才 promote home passed。

## Dependencies and ownership

依賴：[TASK-001](./TASK-001-version-identity-home-state.md)、[TASK-004](./TASK-004-checker-registry-report-cli.md)。

本任務不新增 Desktop check ID；負責框架、入口或交付驗收。

遵循 [README 檢測清單](./README.md#required-validation-matrix)、[System Design](./SYSTEM_DESIGN.md)、[LLD](./LLD.md) 與 [共用交付規則](./README.md#task-delivery-contract)。

## Requirements

### In scope

- 定義完整 fixture schema（含兩 Chart tabs/多 Pane、symbols/timeframes、Study/Strategy、feature-specific ownership），strict validation 與 per-check prerequisites，不要求 Resume Run directory。
- Controlled 包含 read-only stages；設 checking、固定 generation/source fingerprint/context、執行順序及共享 readback observations。
- 在 mutation 前建立 immutable restore context 與 test-owned cleanup ledger；每項 probe 回傳 effect/cleanup contracts，由 coordinator 串行管理。
- 失敗/中斷也 bounded restore；Promise.race timeout 不代表 page operation 已停，需 abort/quiescence 確認，無法確認時停止下一個 write。
- Handling SIGINT/SIGTERM、stale owner recovery 與 drift；只有 explicit check/launch 可以恢復 stale state，普通 command 不做。
- 實作完整 promotion predicate：所有適用 assertions 真實 pass、restore/cleanup 完成、環境/generation/source 未變、report/output 已出版。
- Read-only 成功不清除舊 failed/blocked，也不建立 passed；not_run/missing opt-in/fixture 不能以 optional 或 not_applicable 掩蓋。

### Out of scope

- 不為完成 framework 而自動建立 user 資產、不新增特定 Desktop workaround、不在本任務實作 component probes。

## Design and deliverables

預計修改／新增：src/core/compatibility/check.js、fixture/restore coordinator、report/store interfaces；重用 chart-session/pane runtime guards。

Task-owned effects 與可恢復欄位依 README 各 check contract，history cache growth 不要求 rollback。Framework 提供共享 mutation/restore 介面；check owners 填入行為與驗證，不各自再實作鎖與 report publication。

Deliverables：上述實作、必要 fixtures/tests、registry/CLI wiring（適用時）與 completion evidence；不得只新增 stub 或只寫設計文件就標 done。

## Verification and Delivery

### Tests

- Success、mid-mutation failure、timeout pending operation、SIGINT/SIGTERM、restore/cleanup failure、generation/source drift。
- 未擁有資產不能刪除、lease fencing、report/output/state-write failure 組合不 produce passed。
- Controlled incomplete implementation、unknown entitlement、missing opt-in、readonly pass over earlier failure 的真值表。

### Acceptance criteria

- [ ] 無已知 quiescence 時不重疊下一個 mutation 或假裝 restore 成功。
- [ ] Controlled 成功/失敗都有 restore/cleanup evidence 與可操作下一步。
- [ ] Report 先出版，state 才能有條件 promote，stale worker 不能覆蓋新觀察。
- [ ] Test-only handlers 可證明框架，但不算 Desktop compatibility evidence。

### Validation commands

以下是任務實作後的 target commands；新增 test files 需同步加入實際測試入口。目前不宣稱檔案或測試已存在。

```bash
fnm exec --using=22 node --test tests/compatibility_fixture.test.js tests/compatibility_restore.test.js tests/compatibility_promotion.test.js
fnm exec --using=22 npm run lint
git diff --check
```

## Completion record

Not started. 任務拆分完成不代表 runtime implementation 或 Live certification 完成。
