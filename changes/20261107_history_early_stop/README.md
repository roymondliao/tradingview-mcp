---
id: FIX-20261107-HISTORY-EARLY-STOP
title: History Early Stop
status: design-ready
created: 2026-11-07
scope:
  - history-loading-completion
  - history-completeness-metadata
  - history-empty-range-error
---

# History Early Stop

Fix branch：`fix/tv-history-early-stop`；base：`fork-main` 的 `1d933e1`。
狀態：問題已重現，Desktop 載入／耗盡訊號已驗證，設計與 tasks 已整理，**尚未實作修正**。

## Fix request

`tv history` 在舊資料仍載入時，把 requestMoreDataAvailable=false 誤認為歷史耗盡，
導致舊日期區間失敗，或回傳不完整資料卻標記 complete=true。

採用 client 狀態機，根據 Desktop 的 isLoading、endOfData、endOfDataType、完成事件
與實際最早資料時間，區分等待、進展、到達目標、耗盡與逾時。
不需要改動 TradingView Desktop 或 server。

## Documents

| 文件 | 用途 |
| --- | --- |
| [System design](./SYSTEM_DESIGN.md) | 系統邊界、元件責任、狀態流程、輸出契約與相容性。 |
| [Low level design](./LLD.md) | Runtime 介面、observer、轉換順序、deadline、錯誤及清理細節。 |
| [Verification](./VERIFICATION.md) | 已執行的 TAIEX／6902／離線驗證結果與重做手法。 |
| [Test plan](./TEST_PLAN.md) | 待實作測試矩陣、live 驗收步驟與完成門檻。 |
| [Original issue](./ISSUE-tv-history-early-stop.md) | 原始問題摘要與發現背景；當前決策以設計文件為準。 |

只保留文字結果、必要的摘要數字及操作方法；本 request 的診斷 scripts、原始 JSON
與臨時執行輸出已移除。未移除正式測試，後續 regression tests 仍應放在 tests/。

## Acceptance criteria

- 載入中不得以 more=false 宣告耗盡；一個 loader 不重疊送出請求。
- 到達 from 或已確認的來源耗盡才可 complete=true；資料裁切必須 complete=false。
- 必要訊號缺失、未知 end type、逾時與無進展均有明確結果。
- 尚未載入的空區間與確認空區間使用不同錯誤，CLI／MCP 保留 code／retryable。
- 事件訂閱先於請求，短 CDP 輪詢配合單次與整體 deadline；所有路徑清理 observer。
- 保留日期篩選、去重、上限、no-restore、原圖表還原及檔案輸出契約。
- TAIEX 跨初始範圍可於一次操作完成；6902 上市日前可確認耗盡。

## Tasks

| Task | 狀態 | 依賴 | 交付 |
| --- | --- | --- | --- |
| [TASK-001 Reproduction](./TASK-001-reproduce.md) | done | 無 | 問題與 Desktop 訊號驗證。 |
| [TASK-002 Runtime adapter](./TASK-002-runtime-adapter.md) | todo | TASK-001、設計 | 能力檢查、來源綁定、事件 observer 與有界清理。 |
| [TASK-003 State machine](./TASK-003-state-machine.md) | todo | TASK-002 | 分頁狀態機、deadline、完整性與錯誤。 |
| [TASK-004 Integration](./TASK-004-integration.md) | todo | TASK-003 | Core lifecycle、CLI／MCP 契約及回歸測試。 |
| [TASK-005 Live acceptance](./TASK-005-live-acceptance.md) | todo | TASK-004 | TAIEX／6902 實測、結果文件及使用說明。 |

每項 implementation task 同時交付自己的單元測試；TASK-005 負責整合與真實 Desktop 驗收，
不把測試集中留到所有功能寫完之後。本輪僅設計與文件整理，沒有提交或發布變更。
