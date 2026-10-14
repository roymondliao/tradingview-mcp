---
id: TASK-005
title: Read-only scope and verification promotion
status: implemented
phase: desktop-version-compatibility
depends_on:
  - TASK-001
  - TASK-004
blocks:
  - TASK-006
  - TASK-007
  - TASK-008
  - TASK-009
  - TASK-010
  - TASK-011
  - TASK-012
scope: controlled-framework
---

# TASK-005: Read-only scope and verification promotion

## Goal and scope

依[README](./README.md)與[System Design](./SYSTEM_DESIGN.md)實作Read-only scope and verification promotion。2026-10-14最新scope優先：相容性Gate僅唯讀，操作E2E不計入report或passed前置。

## Requirements

- 驗證唯讀fixture欄位與三組允許的feature exclusions，不得排除六核心。
- 所有適用契約通過及version/context/source/generation/lease fencing成立後，由已出版report建立verification。
- 缺fixture／未執行／中斷／publication或state failure不寫有效passed；沒有controlled前置條件。

## Verification and delivery

Node22 `npm run test:compatibility`、`npm run test:unit`、`npm run test:errors`、`npm run lint`、`git diff --check`。Report counts、缺fixture、版本/source漂移、exclusion evidence、publication/state failure及local-only advisory以deterministic tests驗證；Live結果與平台限制見[Delivery evidence](./DELIVERY_EVIDENCE.md)。

## Completion record

Implementation已完成，2026-10-14依最新唯讀邊界修訂。舊controlled/restore條件已移出相容性驗收；操作helpers與fake-driver回歸留在tests，並非live E2E通過證據。當前範圍的Live verification紀錄集中於Delivery evidence，未測平台與排除能力不推論受支援。
