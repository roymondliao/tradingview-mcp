---
id: FIX-20261127-REPLAY-API-LAZY-INIT
title: Replay API 延遲初始化相容性
status: done
created: 2026-11-27
---

# Replay API 延遲初始化相容性

分支為 `fix/replay-api-lazy-init`，基準為 `fork-main` 的 `f56cc49`。

## Fix request

TradingView Desktop 3.5.1 在首次使用 Bar Replay 前，將 `TradingViewApi._replayApi` 保持為 `null`。`tv` 直接讀取該欄位，導致 `tv replay status` 報錯，唯讀相容性檢查也將 `REPLAY-001` 的兩項斷言判為失敗。

統一 CLI、MCP、相容性檢查與診斷命令的 Replay API 取得方式。驗收需從 Replay 尚未初始化的圖表開始，使用 repo 的 fixture 重跑唯讀檢查。

- [失敗復現與調查證據](./REPRODUCTION.md)
- [Low-level design](./LLD.md)
- [回歸與 Desktop 驗收](./TASK-004-verification.md)

## Tasks

| Task | 狀態 | 依賴 |
| --- | --- | --- |
| [TASK-001 復現與確認來源](./TASK-001-reproduce.md) | done | 無 |
| [TASK-002 共用 Replay API 取得方式](./TASK-002-replay-api-resolution.md) | done | TASK-001 |
| [TASK-003 相容性檢查與診斷](./TASK-003-checker-and-diagnostics.md) | done | TASK-002 |
| [TASK-004 回歸與 Desktop 驗收](./TASK-004-verification.md) | done | TASK-002、TASK-003 |
