# Release v1.7.1

Target release：`1.7.1`。Package 與 lockfile 版本同步；依既有流程於 PR 合併後發布。

## Fixes

- 修正 history 在 TradingView Desktop 仍載入舊資料時，提前宣告 no_more_data／complete=true。
- 使用 Desktop 載入與耗盡狀態、完成事件及有期限的 client 狀態機，等待每批資料完成。
- 區分確認空區間與尚未載入的範圍；CLI／MCP 保留結構化錯誤及 retryable。
- 加入 observer 清理、來源變更檢查與圖表還原保護。

## Compatibility

既有指令、成功結果欄位、日期篩選與輸出格式保持相容。
部分結果可能新增 load_timeout、history_timeout、unsupported_end_state 停止原因；
必要 Desktop 狀態 API 缺失時明確回報 unsupported，不宣告資料完整。
空區間使用 HISTORY_RANGE_EMPTY；未完成範圍使用對應的 timeout／incomplete 錯誤。

## Validation

Data 測試 66/66、全套 local tests 880/880 通過；lint 無 error，只有 3 個既存 warnings。
Desktop 實測 TAIEX 單次 CLI 抓取 2014-12 共 23 根，6902 正確判定上市日起點與歷史耗盡。
版本一致性檢查通過，CLI --version 顯示 1.7.1。
詳細方法與限制見 [Verification](./VERIFICATION.md)。
