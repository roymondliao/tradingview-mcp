---
id: TASK-001
title: Reproduce History Early Stop
status: done
depends_on: []
---

# TASK-001 Reproduction and Signal Verification

已從 fork-main 建立 fix/tv-history-early-stop，完成以下工作：

- 真實 Desktop 重現 TAIEX 舊區間錯誤與錯誤完整性標記。
- 離線 runtime 重現延遲到達時無等待即返回。
- 6902 實測載入、完成、資料耗盡的狀態及事件，確認最早日為 2023-07-13。
- 記錄既有 history 測試 27/27 通過的 coverage 缺口。
- 完成各輪圖表還原及驗證範圍記錄。

結果與方法已統整至 [VERIFICATION.md](./VERIFICATION.md)。
原始 JSON、診斷 scripts 與臨時輸出已依使用者要求移除。
本 task 完成只代表問題與候選訊號已驗證，不代表修正完成。
