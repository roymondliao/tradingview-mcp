---
id: TASK-013
title: Integration, Live validation and delivery evidence
status: todo
phase: desktop-version-compatibility
depends_on:
  - TASK-002
  - TASK-003
  - TASK-006
  - TASK-007
  - TASK-008
  - TASK-009
  - TASK-010
  - TASK-011
  - TASK-012
blocks: []
scope: delivery-local-and-live
---

# TASK-013: Integration, Live validation and delivery evidence

## Goal

整合所有已實作 checks，驗證從 launch observation 到 user 手動檢測、report 與 home flag 的完整交付，產生可追溯支援證據。

## Dependencies and ownership

依賴：[TASK-002](./TASK-002-launch-version-observation.md)、[TASK-003](./TASK-003-cli-local-advisory-status.md)、[TASK-006](./TASK-006-cdp-target-context-checks.md)、[TASK-007](./TASK-007-chart-data-history-checks.md)、[TASK-008](./TASK-008-study-strategy-checks.md)、[TASK-009](./TASK-009-account-service-checks.md)、[TASK-010](./TASK-010-editor-ui-checks.md)、[TASK-011](./TASK-011-graphics-drawing-checks.md)、[TASK-012](./TASK-012-replay-checks.md)。

本任務不新增 Desktop check ID；負責框架、入口或交付驗收。

遵循 [README 檢測清單](./README.md#required-validation-matrix)、[System Design](./SYSTEM_DESIGN.md)、[LLD](./LLD.md) 與 [共用交付規則](./README.md#task-delivery-contract)。

## Requirements

### In scope

- 核對 17 個 IDs 與全部 required assertion handlers 已落地、dependency DAG/CLI+MCP provider mapping 完整；不能用永久 not_run/skip 完成 Gate。
- 整合同版/異版 launch、warning-only command、read-only 診斷、controlled 成功/失敗/blocked/restore failure、publication與state failure 的完整矩陣。
- 執行適合變更的 deterministic tests/lint/diff check，修復 adapter 時補 old/new sanitized fixtures；這些仍不列入 user Desktop report。
- 使用專用 test fixtures 執行真實 read-only 與 controlled 全適用檢測，Replay 另行 opt-in；未取得環境/權限/fixture 時明確記錄缺口，不能宣告完整通過。
- 建立 runbook、完整 fixture 範例與準備步驟、support matrix/證據模板（版本、OS/arch、CDP/Node、repo/source fingerprint、report refs、restore結果）。
- 針對不相容結果建立可交接的 investigation evidence：expected/observed、已排除前提、known-good baseline或unknown、最小重現、受影響能力；不自行套未審核 workaround。
- 平台 launch shell 的 deterministic coverage 與實際 Live 平台分開標示；不把 macOS live result 宣稱為 Windows/Linux 認證。

### Out of scope

- 不自動升降 Desktop、不在 CI 啟動已登入 session、不發布/推送/merge repo，不以完成文件代替真正認證。

## Design and deliverables

預計修改／新增：registry/runner/CLI/launch integration、tests、runbook、support matrix、completion evidence 與相關 command documentation。

各 component owner 必須在自己的任務交付 tests/probe/registry wiring，這個 task 做最後組合驗證與證據，不能成為把所有測試延後的容器。修復後須重跑全部適用 Desktop checks，不能只重跑單一失敗指令。

Deliverables：上述實作、必要 fixtures/tests、registry/CLI wiring（適用時）與 completion evidence；不得只新增 stub 或只寫設計文件就標 done。

## Verification and Delivery

### Tests

- Registry implementation completeness、未執行/排除真值表、source/generation fencing、兩 writer/launch-check conflict。
- CLI JSON/stderr/exit codes、home跨cwd、多endpoint、corrupt state、report redaction/counts、failed publish不 promote。
- Live 六核心＋適用 feature checks，全流程 cleanup/restore。跨平台沒測的地方用明確 not-validated evidence。

### Acceptance criteria

- [ ] 前置任務完成，17 個 registry checks 沒有缺失 required handlers。
- [ ] 維護者 regression與完整適用 Live Gate 均有真實結果；阻塞不冒充完成。
- [ ] Runbook/support evidence 可重現且不含 credentials/private payload。
- [ ] 所有 TASK completion records、README status 與實際交付一致。

### Validation commands

以下是任務實作後的 target commands；新增 test files 需同步加入實際測試入口。目前不宣稱檔案或測試已存在。

```bash
fnm exec --using=22 npm run test:unit
fnm exec --using=22 npm run test:errors
fnm exec --using=22 npm run lint
git diff --check
```

Live target commands：

```bash
fnm exec --using=22 npm run tv -- compatibility status
fnm exec --using=22 npm run tv -- compatibility check --profile read-only --fixture /absolute/path/fixture.json
fnm exec --using=22 npm run tv -- compatibility check --profile controlled --fixture /absolute/path/fixture.json --include-replay
```

若 Replay Trading 適用，另加 `--include-replay-trading`。既有 package scripts 若重複同一 suite 不必重跑；必要新增 tests 與 error-policy tests 不可漏掉。Live 缺前提時保留 blocked，Task 不標完成。

## Completion record

Not started. 任務拆分完成不代表 runtime implementation 或 Live certification 完成。
