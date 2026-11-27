# TASK-002 共用 Replay API 取得方式

狀態為 **done**，依賴 TASK-001。

- 在 `connection.js` 實作頁面端共用探測，支援已有快取及非同步存取器。
- 將 `getReplayApi()` 接到共用探測，保留 Replay Core 使用的頁面運算式。
- 測試涵蓋首次載入、重用快取、舊版路徑和無法初始化。CDP 成功連線但 Replay API 不可用時，CLI 以操作失敗結束並回傳 Replay 專用的錯誤碼。
