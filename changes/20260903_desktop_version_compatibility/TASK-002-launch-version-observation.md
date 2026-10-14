---
id: TASK-002
title: Shared launch version observation
status: implemented
phase: desktop-version-compatibility
depends_on:
  - TASK-001
blocks:
  - TASK-013
scope: launch-integration
---

# TASK-002: Shared launch version observation

## Goal and scope

依[README](./README.md)與[System Design](./SYSTEM_DESIGN.md)實作Shared launch version observation。2026-10-14最新scope優先：相容性Gate僅唯讀，操作E2E不計入report或passed前置。

## Requirements

- macOS／Linux／BAT／VBS與shared Core launch共用observer。
- 重用CDP readiness response；同版不清除失敗，異版與checker revision變更失效；launch/check互斥。

## Verification and delivery

Node22 `npm run test:compatibility`、`npm run test:unit`、`npm run test:errors`、`npm run lint`、`git diff --check`。Report counts、缺fixture、版本/source漂移、exclusion evidence、publication/state failure及local-only advisory以deterministic tests驗證；Live結果與平台限制見[Delivery evidence](./DELIVERY_EVIDENCE.md)。

## Completion record

Implementation已完成，2026-10-14依最新唯讀邊界修訂。舊controlled/restore條件已移出相容性驗收；操作helpers與fake-driver回歸留在tests，並非live E2E通過證據。當前範圍的Live verification紀錄集中於Delivery evidence，未測平台與排除能力不推論受支援。
