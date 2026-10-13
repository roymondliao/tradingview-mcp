---
id: TASK-001
title: Version identity and home state foundation
status: todo
phase: desktop-version-compatibility
depends_on: []
blocks:
  - TASK-002
  - TASK-003
  - TASK-004
  - TASK-005
scope: local-foundation
---

# TASK-001: Version identity and home state foundation

## Goal

建立 launch、CLI advisory 與手動 checker 共用的版本身分、本地狀態與鎖定基礎，避免不同版本或不同 endpoint 誤用 passed。

## Dependencies and ownership

無前置任務。

本任務不新增 Desktop check ID；負責框架、入口或交付驗收。

遵循 [README 檢測清單](./README.md#required-validation-matrix)、[System Design](./SYSTEM_DESIGN.md)、[LLD](./LLD.md) 與 [共用交付規則](./README.md#task-delivery-contract)。

## Requirements

### In scope

- 解析 CDP /json/version 的 TVDesktop/TradingView tokens、Electron/Chromium/Protocol；exact version、token conflict、explicit input fallback 遵循 LLD，不用 Browser 冒充 Desktop。
- 提供 bounded version observer 與純 parser；沿用既有 host/port precedence。Ordinary advisory 只能 import 純 identity/store，不能因載入模組而探測 CDP。
- 實作 os.homedir() 下 state schema v1、endpoint partition、observed/verification/last_check/active_check、revision invalidation 與完整 identity 比對；沒有 TTL。
- Bounded read、unknown/corrupt schema 處理、writer 保留 corrupt backup、owner-only 權限、same-filesystem atomic read-modify-write；跨 endpoint 更新不可遺失。
- 短 state transaction lock 與 launch/check 共用的 endpoint execution lease：owner token、generation fencing、bounded conflict、SIGKILL 後的明確 recovery；不可僅靠 heartbeat 過期接管活 owner。
- 定義 pure state transitions 與 promotion eligibility interface。真正的 report eligibility 由 TASK-004 建立，publication/promotion wiring 由 TASK-004/005 完成；本任務不得自行創造 passed。

### Out of scope

- 不整合 launch scripts 或 router，不建立 registry/probes，不執行真實 Desktop mutation。

## Design and deliverables

預計修改／新增：src/core/compatibility/version.js、identity.js、store.js；需要時拆出 lease.js。

對 consumer 提供 parse/observe、readState、withStateTransaction、acquireEndpointLease 與 observation-generation compare-and-update。所有 filesystem/clock/process-liveness seams 可注入；tests 僅使用 temporary home。

Deliverables：上述實作、必要 fixtures/tests、registry/CLI wiring（適用時）與 completion evidence；不得只新增 stub 或只寫設計文件就標 done。

## Verification and Delivery

### Tests

- 兩 token 一致/衝突/缺失、patch/pre-release、HTTP/JSON/size/timeout、explicit version mismatch。
- Missing/corrupt/oversized state、權限失敗、concurrent writers、endpoint isolation、revision mismatch、atomic publication failure。
- 同版失敗保留、異版失效、舊 owner 不覆蓋新 generation、alive/dead/unknown owner 的 lease 行為。

### Acceptance criteria

- [ ] Version parser 與 identity comparison 對所有 consumer 提供單一契約。
- [ ] Local state reader 不呼叫 network/CDP/Git/process inspection，不隱性寫 home。
- [ ] 同一 endpoint 的 launch/check 不可並行；不同 endpoint state 不互相覆寫。
- [ ] 寫入失敗或身分不完整不能產生有效 passed。

### Validation commands

以下是任務實作後的 target commands；新增 test files 需同步加入實際測試入口。目前不宣稱檔案或測試已存在。

```bash
fnm exec --using=22 node --test tests/compatibility_version.test.js tests/compatibility_store.test.js tests/compatibility_lease.test.js
fnm exec --using=22 npm run lint
git diff --check
```

## Completion record

Not started. 任務拆分完成不代表 runtime implementation 或 Live certification 完成。
