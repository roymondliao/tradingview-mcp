---
id: TASK-003
title: History State Machine and Deadlines
status: done
depends_on: [TASK-002]
---

# TASK-003 History State Machine and Deadlines

依 [LLD](./LLD.md) 建立 src/core/history-loader.js、history-errors.js。

## Work

- 實作 INSPECT／REQUEST／WAIT 及完成、部分結果、失敗的轉換。
- 一次只允許一個未確認 request；more 只用於發送許可，不判斷耗盡。
- 依 loading、已驗證 end type、first_time 與事件 baseline 判斷 settled outcome。
- 單次／整體 monotonic deadlines；不重設 pending 期限、不自動 retry。
- 保留區間 Map、去重、排序、有效筆數上限與只讀增量 bars。
- 定義 typed history errors 及空區間／不完整區間差異。
- 以 fake clock 和非同步 snapshots 測試，不以真實 sleep 等待。

## Acceptance

TEST_PLAN U01、U04～09、U12～16、U20、U22 與 U10／11／18／21 的 loader 部分通過。
覆蓋 more=false/loading=true、end=true/more=true、end=true/loading=true、
isCompleted=true/loading=true 及沒有事件但資料完成的情境。
超時結果 complete=false；空結果保留具體原因，不回通用不可重試的 range error。
所有實際截斷皆不能 complete=true。

交付 loader、error factory、單元測試；公開 getHistory lifecycle 接入由 TASK-004 完成。

## Completion record

2026-11-07 完成。交付內容及檢查結果見 [修正後驗收](./VERIFICATION.md#修正後驗收)。
