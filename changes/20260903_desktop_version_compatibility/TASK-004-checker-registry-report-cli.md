---
id: TASK-004
title: Checker registry, report pipeline and read-only CLI
status: todo
phase: desktop-version-compatibility
depends_on:
  - TASK-001
  - TASK-003
blocks:
  - TASK-005
  - TASK-006
scope: checker-framework
---

# TASK-004: Checker registry, report pipeline and read-only CLI

## Goal

建立手動檢測的可執行骨架：registry、read-only runner、environment check、分類、報告出版與 CLI，讓後續 component probes 接入同一契約。

## Dependencies and ownership

依賴：[TASK-001](./TASK-001-version-identity-home-state.md)、[TASK-003](./TASK-003-cli-local-advisory-status.md)。

本任務擁有的 Desktop check IDs：`ENV-001`。每個 check 的 read-only／controlled assertions 都在本任務交付（ENV 僅 metadata/preflight）。

遵循 [README 檢測清單](./README.md#required-validation-matrix)、[System Design](./SYSTEM_DESIGN.md)、[LLD](./LLD.md) 與 [共用交付規則](./README.md#task-delivery-contract)。

## Requirements

### In scope

- 建立全部 17 個 check 的固定 IDs、component、stable assertions、dependency DAG、profiles、preconditions、timeouts 與 CLI/MCP impact mapping；未實作的 handler 必須明確 not_run。
- ENV-001 重新讀 live exact version/source、收集 environment/revisions/source fingerprint、前後身分一致性；重用 TASK-001 parser，不猜版本。
- 交付 check default read-only、fixture/version/output/force argument contracts；嚴格不改 Desktop state。Controlled 尚未接入時拒絕實際 mutation 並明確標 not_run/validation_blocked。
- 實作五種 assertion status、component read/controlled/full status、compatible 三值、overall precedence、root/dependency impact、baseline comparison、counts/coverage invariants。
- Sanitized bounded report 包含 expected/observed、failure_origin/version_relation、next_steps、restore/cleanup/promotion；report schema 集中驗證。
- 先 atomic 發布 home canonical report 與要求的 output 副本，再更新 last_check/state；state_update 另在 CLI summary 回傳。Read-only 不建立新 verification，failure/blocked 可使舊 passed 失效。
- 既有檔案覆寫規則、protected paths、publication failure/superseded、目前 router 0/1/2/130/143 行為需保留。

### Out of scope

- 不實作 TASK-006～012 的 runtime probes，不要求 regression-report，不把 wrapper/unit tests 列為 checks。

## Design and deliverables

預計修改／新增：src/core/compatibility/registry.js、check.js、report.js、environment.js（或等價拆分）、src/cli/commands/compatibility.js。

Production registry 一開始即包含完整宣告，registration 與 implemented-handler coverage 分開驗證。Partial implementation 的 selected profile 尚有 required read assertion not_run 時不能 diagnostics_passed；full promotion 保持關閉，直到真正全部所需 assertion 通過。測試用 fake handlers 只存在測試 seam。

Deliverables：上述實作、必要 fixtures/tests、registry/CLI wiring（適用時）與 completion evidence；不得只新增 stub 或只寫設計文件就標 done。

## Verification and Delivery

### Tests

- Registry ID 唯一/無依賴循環、全部 CLI/MCP Desktop providers mapping、stage handler 未交付時無法假通過。
- Aggregate truth tables、counts 加總、nullable/exclusions、root failures 不重複、跨版本或不同 fixture baseline 不硬比較。
- JSON schema/redaction/limits、atomic output/protected paths、write failure、superseded、readonly no-mutation、ENV version mismatch。

### Acceptance criteria

- [ ] compatibility check 可產出含全部 check/未執行 assertions 的有效報告。
- [ ] 錯誤與 coverage 缺口不會被 success wrapper 或空資料掩蓋。
- [ ] Report 已出版不等於 state 已更新，CLI summary 正確區分兩者。
- [ ] 任何未交付 required probe 都不能使 state passed。

### Validation commands

以下是任務實作後的 target commands；新增 test files 需同步加入實際測試入口。目前不宣稱檔案或測試已存在。

```bash
fnm exec --using=22 node --test tests/compatibility_registry.test.js tests/compatibility_report.test.js tests/compatibility_check.test.js tests/cli.test.js
fnm exec --using=22 npm run lint
git diff --check
```

## Completion record

Not started. 任務拆分完成不代表 runtime implementation 或 Live certification 完成。
