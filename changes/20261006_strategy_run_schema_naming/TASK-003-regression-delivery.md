---
id: TASK-003
title: Regression, Documentation and Delivery Gate
status: done
phase: strategy-run-schema-naming
depends_on:
  - TASK-002
scope: regression-and-delivery
---

# TASK-003: Regression, Documentation and Delivery Gate

## Goal

完成所有fixtures、benchmarks、operator documentation與regression validation，證明schema naming改善沒有改變Strategy execution與durability semantics。

## Requirements

- 更新直接建立Formal Run artifacts的test／benchmark fixtures。
- 保留專用legacy v2 fixtures，避免全部mechanical改成v3後失去compatibility coverage。
- 更新current artifact examples和Run Config／persisted request差異說明。
- 在Durable Export Recovery文件加入follow-up reference，不竄改歷史v2 decision。
- 新增release note：new writes are v3；existing v2 Resume remains supported and format-preserving。
- 搜尋production、tests、scripts、docs中所有formal artifact `schema_version` assumptions並逐一分類。

## Validation

- Targeted artifact／Run／Resume／fault tests。
- Full unit suite on repository-supported Node version。
- ESLint。
- `git diff --check`。
- JSON examples parse successfully。
- Read-only inspection of a representative existing v2 Run Directory。

## Acceptance criteria

- [x] Current docs只把new formal artifacts描述為v3。
- [x] Historical v2 docs保留原decision並連結本Change。
- [x] V2 compatibility fixtures與v3 new-write fixtures都有明確目的。
- [x] Full validation passes with no unrelated behavior changes。
- [x] Delivery evidence記錄commands、results與known limitations。

## Completion record

Completed on 2026-10-07. Validation details見[`DELIVERY_EVIDENCE.md`](./DELIVERY_EVIDENCE.md)。
