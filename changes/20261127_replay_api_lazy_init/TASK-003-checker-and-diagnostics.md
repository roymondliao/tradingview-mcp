# TASK-003 相容性檢查與診斷

狀態為 **done**，依賴 TASK-002。

- 將 `REPLAY-001.read.capability` 及 `REPLAY-001.read.state` 接到共用探測，保留指定圖表與現有唯讀範圍。
- 區分入口缺失、初始化失敗、必要方法缺失與狀態回傳格式不符。
- 更新 `tv discover`、`tv ui-state` 和相容性實作識別。
- 單元測試驗證缺少操作方法時仍可獨立驗證可讀狀態。Desktop 上的診斷輸出在 Replay 尚未初始化時成功讀取狀態。
