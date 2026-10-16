---
id: TASK-001
title: Artifact v5 and Update Lineage
status: done
phase: strategy-run-update
depends_on:
  - FEATURE-20261007-STRATEGY-RUN-EXTENSION
blocks:
  - TASK-002
scope: update-artifact-contract
---

# TASK-001: Artifact v5 and Update Lineage

## Goal

保存 Update provenance 與完整實驗集合，維持舊 artifacts 相容及獨立 recovery。

## Implementation

- `src/core/strategy-run-state.js`：v5 family、Update metadata strict validation。
- `src/core/strategy-run-lineage.js`：Update root、provenance fingerprint、Extension traversal。
- `src/core/strategy-extend.js`：從 v5 source 建立 v5 Extension。
- `src/core/strategy-resume.js`：共用 evidence validation 與 Update response fields。

## Acceptance criteria

- [x] Update metadata 不混入 v4；source ID、版本、fingerprints 與實驗數受驗證。
- [x] Update 作為完整新 root，重複更新不累加來源實驗。
- [x] 舊 v2／v3／v4 來源不被遷移。
- [x] Update 可獨立 Resume，並支援下一次 Update／Extend。

驗證來源：[delivery evidence](./DELIVERY_EVIDENCE.md)。
