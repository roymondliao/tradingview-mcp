---
id: TASK-013
title: Integration, Live validation and delivery evidence
status: done
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

## Goal and scope

依[README](./README.md)與[System Design](./SYSTEM_DESIGN.md)實作Integration, Live validation and delivery evidence。2026-10-14最新scope優先：相容性Gate僅唯讀，操作E2E不計入report或passed前置。

## Requirements

- 核對17checks／37唯讀handlers與provider mapping，完成本地回歸、lint、report/state failure矩陣。
- 用目前dev fixture做Live唯讀Gate，成功即可更新home passed；不以controlled或E2E作前置。
- 保留精確version/environment/source tuple與exclusion evidence；平台未驗證不宣稱認證。

## Verification and delivery

Node22 `npm run test:compatibility`、`npm run test:unit`、`npm run test:errors`、`npm run lint`、`git diff --check`。Report counts、缺fixture、版本/source漂移、exclusion evidence、publication/state failure及local-only advisory以deterministic tests驗證；Live結果與平台限制見[Delivery evidence](./DELIVERY_EVIDENCE.md)。

## Completion record

Implementation已完成，2026-10-14依最新唯讀邊界修訂。舊controlled/restore條件已移出相容性驗收；操作helpers與fake-driver回歸留在tests，並非live E2E通過證據。當前範圍的Live verification紀錄集中於Delivery evidence，未測平台與排除能力不推論受支援。

2026-10-14 current-scope acceptance：新版readonly Gate實測30 passed／0 failed／0 blocked，7個user-scope exclusions；report schema3已出版，home passed，status讀回確認。788 unit／13 error tests通過，lint0 errors。當前macOS配置驗收完成；排除功能、其他平台及操作E2E不推論受支援，詳見Delivery evidence。

2026-10-14 user手動驗收確認：使用者回覆手動檢測無問題；讀回最新report `2026-10-14T09-31-11-886Z-1c3c1f39-454a-4267-be63-b9045dd36a78.json`：30 passed／0 failed／0 blocked，7個explicit exclusions，home passed。當前設定範圍手動驗收完成。
