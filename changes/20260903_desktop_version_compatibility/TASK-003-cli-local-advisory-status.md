---
id: TASK-003
title: Local-only CLI advisory and compatibility status
status: implemented
phase: desktop-version-compatibility
depends_on:
  - TASK-001
blocks:
  - TASK-004
  - TASK-013
scope: cli-local
---

# TASK-003: Local-only CLI advisory and compatibility status

## Goal and scope

依[README](./README.md)與[System Design](./SYSTEM_DESIGN.md)實作Local-only CLI advisory and compatibility status。2026-10-14最新scope優先：相容性Gate僅唯讀，操作E2E不計入report或passed前置。

## Requirements

- 普通Desktop CLI只讀home state，warning-only且保持原stdout／exit code。
- compatibility status完全local-only，顯示觀察／驗證版本與verified exclusions；help／離線指令跳過。

## Verification and delivery

Node22 `npm run test:compatibility`、`npm run test:unit`、`npm run test:errors`、`npm run lint`、`git diff --check`。Report counts、缺fixture、版本/source漂移、exclusion evidence、publication/state failure及local-only advisory以deterministic tests驗證；Live結果與平台限制見[Delivery evidence](./DELIVERY_EVIDENCE.md)。

## Completion record

Implementation已完成，2026-10-14依最新唯讀邊界修訂。舊controlled/restore條件已移出相容性驗收；操作helpers與fake-driver回歸留在tests，並非live E2E通過證據。當前範圍的Live verification紀錄集中於Delivery evidence，未測平台與排除能力不推論受支援。
