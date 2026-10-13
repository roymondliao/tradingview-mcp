---
id: TASK-006
title: CDP, Target, Layout and Pane checks
status: todo
phase: desktop-version-compatibility
depends_on:
  - TASK-004
  - TASK-005
blocks:
  - TASK-007
  - TASK-008
  - TASK-009
  - TASK-010
  - TASK-011
  - TASK-012
  - TASK-013
scope: core-connection-context
---

# TASK-006: CDP, Target, Layout and Pane checks

## Goal

交付所有後續 checks 共用的連線橋接與資源定位 assertions，確認實際操作的 Chart/Pane 是使用者指定的資源。

## Dependencies and ownership

依賴：[TASK-004](./TASK-004-checker-registry-report-cli.md)、[TASK-005](./TASK-005-controlled-fixture-restore-promotion.md)。

本任務擁有的 Desktop check IDs：`CDP-001`、`TARGET-001`、`CONTEXT-001`。每個 check 的 read-only／controlled assertions 都在本任務交付（ENV 僅 metadata/preflight）。

遵循 [README 檢測清單](./README.md#required-validation-matrix)、[System Design](./SYSTEM_DESIGN.md)、[LLD](./LLD.md) 與 [共用交付規則](./README.md#task-delivery-contract)。

## Requirements

### In scope

- CDP synchronous/async evaluate、callFunctionOn arguments/results、remote object release round-trip；controlled reconnect 只關閉 checker 自有 client。
- 解析 shell/chart/active target，不依 CDP list ordering 猜測；模糊或載入中分別回報。
- 驗證 collection/active widget、runtime Layout、Saved Layout catalog mapping、Pane ownership；合法 nullable 與 required fixture mapping 分開。
- Controlled 在兩個指定 test tabs/多 Pane 間切換並恢復原 active identities，readback 不沿用 stale client。
- 提供 pinned context 給下游；root cause failure 使依賴者 blocked，不重複判多個不相容。
- 保存 3.3.0 legacy／3.4.0 layoutId sanitized regression fixtures；不要求新版同時具有舊 private path。

### Out of scope

- 不 kill/restart Desktop 做故障注入、不讀取 unrestricted page globals、不新增 MCP 專屬 lifecycle probe。

## Design and deliverables

預計修改／新增：compatibility probes；src/connection.js、src/core/tab.js、layout-identity.js、pane.js 的 shared read adapters。

按 README CDP/Target/Context contracts 實作 read/controlled handlers；以 TASK-005 cleanup coordinator 還原 focus。輸出 counts/mapping matches/run-local ID aliases，不能保存完整 target URLs 或帳號 payload。

Deliverables：上述實作、必要 fixtures/tests、registry/CLI wiring（適用時）與 completion evidence；不得只新增 stub 或只寫設計文件就標 done。

## Verification and Delivery

### Tests

- Multi-target ordering、visibility/focus ambiguity、missing chart/layout/pane、legacy/current mapping、wrong ownership。
- Round-trip types/Promise rejection、timeout classification、自有 client reconnect、tab/pane restore failure。
- 缺第二測試 Tab/Pane 為 fixture blocked，不能把單 Tab success 當完整 pass。

### Acceptance criteria

- [ ] 三個 check 的 required read/controlled assertions 都接入 registry，沒有實作 placeholder。
- [ ] 下游拿到固定且驗證過的 context，身分不符無法繼續 mutation。
- [ ] 保留 structured evidence，不因 CDP port 可連就回報完整通過。

### Validation commands

以下是任務實作後的 target commands；新增 test files 需同步加入實際測試入口。目前不宣稱檔案或測試已存在。

```bash
fnm exec --using=22 node --test tests/compatibility_context_checks.test.js tests/connection.test.js tests/layout_identity.test.js tests/pane_context.test.js
fnm exec --using=22 npm run lint
git diff --check
```

Live 驗證透過明確呼叫 `tv compatibility check --profile read-only --fixture <fixture.json>` 與 `--profile controlled` 執行；Replay 依契約加 opt-in。其他尚未實作的 checks 必須仍顯示 not_run，本任務可交付自己的 component evidence，但不能因此宣稱整體 passed。

## Completion record

Not started. 任務拆分完成不代表 runtime implementation 或 Live certification 完成。
