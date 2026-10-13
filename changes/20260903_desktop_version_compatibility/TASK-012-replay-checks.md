---
id: TASK-012
title: Opt-in Replay lifecycle checks
status: todo
phase: desktop-version-compatibility
depends_on:
  - TASK-005
  - TASK-006
  - TASK-007
blocks:
  - TASK-013
scope: feature-replay
---

# TASK-012: Opt-in Replay lifecycle checks

## Goal

在獨立 opt-in fixture 驗證 Replay runtime lifecycle、資料切換與恢復，避免 Replay 操作影響 Strategy 檢測。

## Dependencies and ownership

依賴：[TASK-005](./TASK-005-controlled-fixture-restore-promotion.md)、[TASK-006](./TASK-006-cdp-target-context-checks.md)、[TASK-007](./TASK-007-chart-data-history-checks.md)。

本任務擁有的 Desktop check IDs：`REPLAY-001`。每個 check 的 read-only／controlled assertions 都在本任務交付（ENV 僅 metadata/preflight）。

遵循 [README 檢測清單](./README.md#required-validation-matrix)、[System Design](./SYSTEM_DESIGN.md)、[LLD](./LLD.md) 與 [共用交付規則](./README.md#task-delivery-contract)。

## Requirements

### In scope

- Read-only 檢查必要 _replayApi methods、manager/UI state、loaded chart bars，沒有 opt-in 不啟動 Replay。
- Controlled 只在獨立 replay_target、--include-replay 下執行，從有效 loaded bars 選 bounded 10% recent point；禁 selectFirstAvailableDate。
- 驗證 selectDate Promise、start/step 的資料變化、goToRealtime 先於 stopReplay 的目前 provider 語意，restore symbol/resolution/data readiness/UI。
- Replay Trading 另需 --include-replay-trading；test-owned executions 在 stop 前清理並驗證，未提供 flag 的適用 required assertions not_run。
- 不足 bars/entitlement unknown/缺 opt-in 分別分類；不把未執行或 cleanup 失敗標 pass。
- 與 Strategy checks 依 runner 串行排程，無法確認 replay stop 或 quiescence 就停止後續 writes。

### Out of scope

- 不在 Strategy E2E 隱性執行 Replay，不回到最早可用日期，不執行 broker/live trading。

## Design and deliverables

預計修改／新增：compatibility probes；src/core/replay.js；registry/precondition 與 controlled fixture integration。

Replay fixture 與一般 Strategy fixture 分離；依 TASK-005 納入完整 effect ledger。若不同版本 lifecycle 變更，回報具體 expected/observed ordering，再由 follow-up adapter task 修正，Gate 不自動猜 workaround。

Deliverables：上述實作、必要 fixtures/tests、registry/CLI wiring（適用時）與 completion evidence；不得只新增 stub 或只寫設計文件就標 done。

## Verification and Delivery

### Tests

- No opt-in 零 mutation、Promise/manager/UI 語意、合法 bars selection 與不足資料。
- Stop ordering、step data readback、restore/cleanup timeout、中斷與禁止後續 mutation。
- Separate Trading opt-in/owned executions cleanup、not_applicable evidence 與 not_run 區分。

### Acceptance criteria

- [ ] Replay 只有明確 opt-in 才會動作，report 不隱藏缺測範圍。
- [ ] Stop/restore 經 readback 驗證，原資料身分可恢復。
- [ ] 不需要新增 MCP 特有 Replay 檢測。

### Validation commands

以下是任務實作後的 target commands；新增 test files 需同步加入實際測試入口。目前不宣稱檔案或測試已存在。

```bash
fnm exec --using=22 node --test tests/compatibility_replay_checks.test.js tests/replay.test.js
fnm exec --using=22 npm run lint
git diff --check
```

Live 驗證透過明確呼叫 `tv compatibility check --profile read-only --fixture <fixture.json>` 與 `--profile controlled` 執行；Replay 依契約加 opt-in。其他尚未實作的 checks 必須仍顯示 not_run，本任務可交付自己的 component evidence，但不能因此宣稱整體 passed。

## Completion record

Not started. 任務拆分完成不代表 runtime implementation 或 Live certification 完成。
