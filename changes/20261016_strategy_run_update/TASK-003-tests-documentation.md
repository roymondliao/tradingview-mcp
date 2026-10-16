---
id: TASK-003
title: Update Tests and Documentation
status: done
phase: strategy-run-update
depends_on:
  - TASK-002
blocks: []
scope: local-validation-and-documentation
---

# TASK-003: Update Tests and Documentation

## Goal

驗證完整重跑、lineage/recovery 與版本相容，補齊使用及 feature request 文件。

## Implementation

- `tests/strategy/run/integration/update.test.js`：14 個整合測試。
- `tests/cli/integration/router.test.js`：Update 命令契約。
- `tests/strategy/run/unit/{state,artifacts}.test.js`：明確固定歷史版本 fixtures。
- `README.md`、`docs/strategy_automation_run_manual_test.md`：CLI、前提與驗證步驟。
- `changes/20261016_strategy_run_update/`：需求、設計、tasks、交付證據及 release notes。

## Acceptance criteria

- [x] 全部本機測試通過（813 tests）；CLI 測試通過（44 tests）。
- [x] lint 無 errors；既有 3 warnings 已記錄。
- [x] 使用文件說明實際資料範圍限制與 source Pine/runtime 前提。
- [x] Feature branch 建立，changes 文件補登完成。
- [x] Review 發現的 Resume runtime rebinding 問題已修正，回歸測試與完整 suite 通過。
- [x] Desktop live 驗證未執行的限制明確記錄。

本 Task 範圍為本機驗證與文件，不宣稱 live／release gates 已通過。
詳細結果：[delivery evidence](./DELIVERY_EVIDENCE.md)。
