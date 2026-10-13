---
id: TASK-010
title: Pine Editor and UI provider checks
status: todo
phase: desktop-version-compatibility
depends_on:
  - TASK-005
  - TASK-006
blocks:
  - TASK-013
scope: feature-editor-ui
---

# TASK-010: Pine Editor and UI provider checks

## Goal

驗證 Editor/DOM/React/Monaco 與 UI/Capture 的獨立 Desktop provider，而不把 UI wrapper tests 重複納入報告。

## Dependencies and ownership

依賴：[TASK-005](./TASK-005-controlled-fixture-restore-promotion.md)、[TASK-006](./TASK-006-cdp-target-context-checks.md)。

本任務擁有的 Desktop check IDs：`PINE-001`、`UI-001`。每個 check 的 read-only／controlled assertions 都在本任務交付（ENV 僅 metadata/preflight）。

遵循 [README 檢測清單](./README.md#required-validation-matrix)、[System Design](./SYSTEM_DESIGN.md)、[LLD](./LLD.md) 與 [共用交付規則](./README.md#task-delivery-contract)。

## Requirements

### In scope

- Read-only 僅檢查已存在 panel/editor/canvas；未開 Editor 是 fixture blocked，不先開再還原冒充 read-only。
- 驗證 DOM→React fiber→Monaco env/model method chain、必要 shell/panel/dialog locators 唯一且可用。
- Controlled 專用 Editor 測試 source read/write、compile success 與已知語法錯誤 diagnostics，恢復原 editor/UI；不可覆寫 user 未保存 source。
- 必要 panel/dialog/Tab create-close 及 CDP Input 行為只用 test-owned fixture，readback後恢復；panel label 不能只有 localized text。
- CDP screenshot 的 region bounds/有效影像回應；depth DOM 僅在已證實 entitlement 適用時驗證，否則依 evidence 分類。
- UI restore effects 與 Tab cleanup 使用 TASK-005 coordinator；Report 不保存完整截圖/private source/unrestricted DOM dump。

### Out of scope

- 不重跑所有一般 click/keypress wrapper 的 unit tests 作 Desktop checks，不發布或保存使用者 Pine script。

## Design and deliverables

預計修改／新增：compatibility probes；src/core/pine.js、ui.js、indicators.js、tab.js、capture.js、data.js 的 depth DOM path。

Editor 判定應讀 runtime/compile diagnostics；不能只因 compile button click 成功就通過。UI method存在、locator存在、行為readback分成assertions，顯示精確失敗層。

Deliverables：上述實作、必要 fixtures/tests、registry/CLI wiring（適用時）與 completion evidence；不得只新增 stub 或只寫設計文件就標 done。

## Verification and Delivery

### Tests

- Monaco/React path missing、panel absent、locator ambiguous、compile result/error shape changed。
- Controlled editor dirty-state preflight、restore after failure、test-owned Tab cleanup。
- Screenshot empty/out-of-bounds、depth entitlement unknown vs confirmed not_applicable。

### Acceptance criteria

- [ ] Read-only 無 UI mutation，controlled 對 Editor/UI 有明確 restore readback。
- [ ] Pine compile 必須看到實際結果與錯誤契約，不能僅測存在或 click。
- [ ] UI/Editor failures 不誤判成整個 CDP 失效。

### Validation commands

以下是任務實作後的 target commands；新增 test files 需同步加入實際測試入口。目前不宣稱檔案或測試已存在。

```bash
fnm exec --using=22 node --test tests/compatibility_editor_ui_checks.test.js
fnm exec --using=22 npm run lint
git diff --check
```

Live 驗證透過明確呼叫 `tv compatibility check --profile read-only --fixture <fixture.json>` 與 `--profile controlled` 執行；Replay 依契約加 opt-in。其他尚未實作的 checks 必須仍顯示 not_run，本任務可交付自己的 component evidence，但不能因此宣稱整體 passed。

## Completion record

Not started. 任務拆分完成不代表 runtime implementation 或 Live certification 完成。
