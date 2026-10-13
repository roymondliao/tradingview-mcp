---
id: TASK-003
title: Local-only CLI advisory and compatibility status
status: todo
phase: desktop-version-compatibility
depends_on:
  - TASK-001
blocks:
  - TASK-004
  - TASK-013
scope: cli-local
---

# TASK-003: Local-only CLI advisory and compatibility status

## Goal

在普通 Desktop command 前只讀 home 狀態並給一次 warning；提供完全 local-only 的 compatibility status。

## Dependencies and ownership

依賴：[TASK-001](./TASK-001-version-identity-home-state.md)。

本任務不新增 Desktop check ID；負責框架、入口或交付驗收。

遵循 [README 檢測清單](./README.md#required-validation-matrix)、[System Design](./SYSTEM_DESIGN.md)、[LLD](./LLD.md) 與 [共用交付規則](./README.md#task-delivery-contract)。

## Requirements

### In scope

- 登錄 desktop_dependency=required/none/launch/compatibility；parent inheritance 與 leaf override 明確，完整 inventory test 不允許漏分類。
- 在 command/help 解析後、handler 前讀 bounded state，檢查 schema/endpoint/version binding/local revisions；passed 無提示，其餘 stderr 單行 bounded warning 後仍執行。
- Help/version、pine analyze/不依賴 Desktop 的 pine check、launch、compatibility 豁免；strategy run/extend dry-run 仍 required。
- 一個 invocation 最多一次 advisory；stream 只在開始提示。不得 network/CDP/process query、修復或建立 home 檔案。
- compatibility status 回傳 last observed version/time、effective state、last check/report reference，不能稱作 live version。
- 保留原 handler stdout schema、error normalization 與 exit code。Check command 待 TASK-004 交付，不建立會假裝成功的 placeholder handler。

### Out of scope

- 不探測 Desktop，不執行檢測，不給一般 MCP tools 增加相容性檢查入口。

## Design and deliverables

預計修改／新增：src/core/compatibility/advisory.js、src/cli/router.js、src/cli/commands/compatibility.js、src/cli/index.js 與 leaf command metadata。

Advisory 是不拋出阻擋 handler 例外的純本地 service；router 只負責序列化 warning。Local status 必須在 Desktop 未啟動時仍可使用。

Deliverables：上述實作、必要 fixtures/tests、registry/CLI wiring（適用時）與 completion evidence；不得只新增 stub 或只寫設計文件就標 done。

## Verification and Delivery

### Tests

- 全部 leaf classification、help/local exemptions、required dry-run、missing/corrupt/oversized/failed/checking state。
- Network/process/write seams 一旦被 advisory 呼叫即 fail。
- Warning 後 handler success/error/connection error exit code 不變，stdout 仍可解析；status 無 CDP。

### Acceptance criteria

- [ ] 普通 command 每次只讀本地 flag，不查 live version。
- [ ] 未通過仍繼續 command，沒有新增阻擋政策或 warning suppression TTL。
- [ ] Local status 可讀缺失紀錄，不會為查詢而寫 state。
- [ ] 不同 cwd 仍讀相同 home；help/version 完全跳過 advisory。

### Validation commands

以下是任務實作後的 target commands；新增 test files 需同步加入實際測試入口。目前不宣稱檔案或測試已存在。

```bash
fnm exec --using=22 node --test tests/compatibility_advisory.test.js tests/compatibility_status.test.js tests/cli.test.js
fnm exec --using=22 npm run lint
git diff --check
```

## Completion record

Not started. 任務拆分完成不代表 runtime implementation 或 Live certification 完成。
