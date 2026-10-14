---
id: TASK-009
title: Account Pine, Watchlist and Alert checks
status: implemented
phase: desktop-version-compatibility
depends_on:
  - TASK-005
  - TASK-006
blocks:
  - TASK-013
scope: feature-account-services
---

# TASK-009: Account Pine, Watchlist and Alert checks

## Goal and scope

依[README](./README.md)與[System Design](./SYSTEM_DESIGN.md)實作Account Pine, Watchlist and Alert checks。2026-10-14最新scope優先：相容性Gate僅唯讀，操作E2E不計入report或passed前置。

## Requirements

- 驗證已登入的Pine／Watchlist／Alerts inventory及指定資源讀取。
- 不建立／更新／刪除Script或Alert，不修改Watchlist；這些屬E2E。

## Verification and delivery

Node22 `npm run test:compatibility`、`npm run test:unit`、`npm run test:errors`、`npm run lint`、`git diff --check`。Report counts、缺fixture、版本/source漂移、exclusion evidence、publication/state failure及local-only advisory以deterministic tests驗證；Live結果與平台限制見[Delivery evidence](./DELIVERY_EVIDENCE.md)。

## Completion record

Implementation已完成，2026-10-14依最新唯讀邊界修訂。舊controlled/restore條件已移出相容性驗收；操作helpers與fake-driver回歸留在tests，並非live E2E通過證據。當前範圍的Live verification紀錄集中於Delivery evidence，未測平台與排除能力不推論受支援。
