---
id: TASK-011
title: Pine graphics and Drawing checks
status: todo
phase: desktop-version-compatibility
depends_on:
  - TASK-005
  - TASK-006
  - TASK-008
blocks:
  - TASK-013
scope: feature-graphics-drawing
---

# TASK-011: Pine graphics and Drawing checks

## Goal

驗證 Pine primitives 與 Chart drawing entities 的資料/操作契約，補足六個核心不能推論的圖形功能。

## Dependencies and ownership

依賴：[TASK-005](./TASK-005-controlled-fixture-restore-promotion.md)、[TASK-006](./TASK-006-cdp-target-context-checks.md)、[TASK-008](./TASK-008-study-strategy-checks.md)。

本任務擁有的 Desktop check IDs：`GRAPHICS-001`、`DRAWING-001`。每個 check 的 read-only／controlled assertions 都在本任務交付（ENV 僅 metadata/preflight）。

遵循 [README 檢測清單](./README.md#required-validation-matrix)、[System Design](./SYSTEM_DESIGN.md)、[LLD](./LLD.md) 與 [共用交付規則](./README.md#task-delivery-contract)。

## Requirements

### In scope

- 已可見的 known Study 能讀 lines/labels/tables/boxes primitives，座標/文字/cell shape 符合 fixture。
- Controlled 需要 graphics setup 時重用 Study test-owned setup，不創建第二套 fixture lifecycle。
- Drawing inventory/getShapeById/points/properties readable；controlled create/get/remove 可驗證 geometry/identity。
- 只刪除本輪已記錄的 shape/entity IDs，不使用 removeAllShapes/delete-all 作 cleanup。
- Runtime numeric/text contracts 與本地 dedupe/formatters 分開；後者留 repo tests，不重複作 Desktop check。

### Out of scope

- 不修改使用者既有 drawings，不測所有美術樣式、不把 screenshots 作唯一正確性證據。

## Design and deliverables

預計修改／新增：compatibility probes；src/core/data.js、stream.js 的 _graphics readers、drawing.js；重用 TASK-008 test Study fixture helpers。

Pine graphics 與 user Drawing 不是同一個資源模型：前者來自 Study private collections，後者走 Chart shape API，必須分開 assertions 與 error origins。

Deliverables：上述實作、必要 fixtures/tests、registry/CLI wiring（適用時）與 completion evidence；不得只新增 stub 或只寫設計文件就標 done。

## Verification and Delivery

### Tests

- Primitives nested map shape、missing collection vs hidden/missing fixture、各四種類型的欄位。
- Drawing ID/geometry mismatch、create-no-new-entity、remove still exists、mid-operation cleanup。
- 多個 Study/shape 下 identity 精確匹配，fixture cleanup 不影響既有資產。

### Acceptance criteria

- [ ] 兩個 check 的資料與行為 evidence 分開，沒有以空結果或 methods presence 偽成功。
- [ ] Graphics setup 納入既有 Study ownership ledger，Drawing cleanup 可讀回。
- [ ] Shared source 不因 data/stream/CLI/MCP 多入口而重複計分。

### Validation commands

以下是任務實作後的 target commands；新增 test files 需同步加入實際測試入口。目前不宣稱檔案或測試已存在。

```bash
fnm exec --using=22 node --test tests/compatibility_graphics_drawing_checks.test.js
fnm exec --using=22 npm run lint
git diff --check
```

Live 驗證透過明確呼叫 `tv compatibility check --profile read-only --fixture <fixture.json>` 與 `--profile controlled` 執行；Replay 依契約加 opt-in。其他尚未實作的 checks 必須仍顯示 not_run，本任務可交付自己的 component evidence，但不能因此宣稱整體 passed。

## Completion record

Not started. 任務拆分完成不代表 runtime implementation 或 Live certification 完成。
