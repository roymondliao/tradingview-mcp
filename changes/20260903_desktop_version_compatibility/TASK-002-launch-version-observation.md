---
id: TASK-002
title: Shared launch version observation
status: todo
phase: desktop-version-compatibility
depends_on:
  - TASK-001
blocks:
  - TASK-013
scope: launch-integration
---

# TASK-002: Shared launch version observation

## Goal

所有受控啟動入口在 CDP ready 後登錄實際 Desktop version，將同版保留、異版未驗證與啟動失敗狀態一致寫入 home。

## Dependencies and ownership

依賴：[TASK-001](./TASK-001-version-identity-home-state.md)。

本任務不新增 Desktop check ID；負責框架、入口或交付驗收。

遵循 [README 檢測清單](./README.md#required-validation-matrix)、[System Design](./SYSTEM_DESIGN.md)、[LLD](./LLD.md) 與 [共用交付規則](./README.md#task-delivery-contract)。

## Requirements

### In scope

- beginLaunchObservation 在 kill/restart 前取得 endpoint lease、建立 pending generation；成功/失敗均更新狀態並 release。
- 重用 launch 取得的成功 /json/version response；shell 以 stdin/file 安全傳入 Node helper，不額外重複查版本或自行拼 JSON。
- 相同 identity 只恢復有效舊狀態；不同 identity 為 unchecked，未知 version/pending crash 為 blocked；不能清除同版 failed。
- macOS/Linux/BAT/VBS、tv launch、existing MCP launch、no-kill 與 MSIX fallback 全部接共同 observer。VBS 必須 bounded wait CDP。
- 啟動前檢查 Node/helper 可用性；home 寫入失敗回報 bookkeeping failure，說明 Desktop 可能已啟動，不自動關閉它。
- Core 回傳 compatibility summary，由 CLI/MCP 各自呈現；不新增一般 MCP tools 的版本檢查。

### Out of scope

- 不執行 core compatibility probes、不引入 TTL、不改原本平台安裝位置搜尋策略。

## Design and deliverables

預計修改／新增：src/core/compatibility/launch.js、scripts/compatibility-launch.js、src/core/health.js、src/tools/health.js，以及 macOS/Linux/BAT/VBS launch scripts。

Shell 只處理平台啟動及 metadata 傳遞，版本解析/state transition 留在 shared Core。Launch observer 的測試以 fake CDP response 與 process adapters 驗證，不為測試 kill 真實 Desktop。

Deliverables：上述實作、必要 fixtures/tests、registry/CLI wiring（適用時）與 completion evidence；不得只新增 stub 或只寫設計文件就標 done。

## Verification and Delivery

### Tests

- 同版 passed/failed、異版、token 缺失、CDP timeout、helper 缺失、寫入失敗、superseded generation。
- All launcher entry points 的 helper routing、port/path with spaces、stdin JSON、lease 在任何 restart 前取得。
- tv launch/Core/MCP 的成功與 warning/error 呈現；no-kill/MSIX fallback 不漏 observation。

### Acceptance criteria

- [ ] 所有五類入口（macOS/Linux/BAT/VBS/shared Core）都有登錄路徑與測試。
- [ ] 一次成功 CDP readiness response 可直接供 observer 使用，不重複 probe。
- [ ] 版本改變只寫 unchecked，不寫 verified version。
- [ ] 啟動與檢測互斥，錯誤不留下有效舊 passed。

### Validation commands

以下是任務實作後的 target commands；新增 test files 需同步加入實際測試入口。目前不宣稱檔案或測試已存在。

```bash
fnm exec --using=22 node --test tests/compatibility_launch.test.js tests/launch.test.js
fnm exec --using=22 npm run lint
git diff --check
```

## Completion record

Not started. 任務拆分完成不代表 runtime implementation 或 Live certification 完成。
