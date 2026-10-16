---
id: TASK-002
title: Update Adapter and CLI
status: done
phase: strategy-run-update
depends_on:
  - TASK-001
blocks:
  - TASK-003
scope: update-orchestration
---

# TASK-002: Update Adapter and CLI

## Goal

新增無日期／Config 參數的 Update 命令，以既有 shared durable lifecycle 完整重跑。

## Implementation

- `src/core/strategy-update.js`：來源讀取、驗證、計畫重建及 lifecycle adapter。
- `src/cli/commands/strategy.js`：options、help、signal/progress wrapper。
- `src/core/index.js`：公開 `strategyUpdate`。
- `src/core/strategy-error-policy.js`：Update domain error kinds。

## Acceptance criteria

- [x] 支援 `--run-directory` 與 `--dry-run`，不要求原 Config 或日期。
- [x] 沿用來源 base inputs、parameter sets、timeframe 與 frozen Symbols。
- [x] 比對重建 plans，取得 ownership 後再次驗證。
- [x] 新建 sibling directory，呼叫 `executePreparedDurableRun()`，不另寫執行引擎。
- [x] Source failures 與 collisions 不修改既有結果，錯誤分類保留 infrastructure 語意。

驗證來源：[delivery evidence](./DELIVERY_EVIDENCE.md)。
