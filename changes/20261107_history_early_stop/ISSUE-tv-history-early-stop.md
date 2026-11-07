# History Early Stop Original Issue

來源：使用者提供的 2026-11-07 問題文件。此處保留問題摘要與發現背景；
原始診斷輸出及外部 repository 路徑不作為本 request 的文件依賴。
狀態：已重現並修正，驗收通過；後續實測見 [VERIFICATION.md](./VERIFICATION.md)。

## Reported behavior

tradingview-mcp 1.7.0（commit 1d933e1）在請求更舊 K 棒後，
將 requestMoreDataAvailable() 暫時的 false 當成沒有更多資料。

- 指定早於初始約 300 根資料的 from/to 時，回 No historical bars matched the requested date range，
  CORE_UNCLASSIFIED_ERROR，retryable=false。
- 僅指定 from 時可能回傳初始資料，卻標示 no_more_data／complete=true。
- 預設還原原商品會丟失累積載入的資料，因此直接重試未必能解決。

## Discovery background

原始案例是補 INDEX:TAIEX 的 2014-12 日線，供 2015-01 大盤月報酬計算。
來源工作流程另有 2024-12 抓取失敗的記錄；是否同原因需由各自資料驗證，不能直接推定。

原報告保留圖表後重跑，筆數由 300→1,300→2,300 增加，最後能取得 2014-12 的 23 根。
這支持「請求有效，但 client 在資料到達前返回」的推論；本 request 後續已用真實 Desktop 確認。

## Impact

回傳不完整資料卻標記完整，可能讓下游 coverage／producer_complete 紀錄不正確。
目前未逐一核對下游 warehouse；不能宣稱所有既有匯入都受影響。

## Temporary workaround

暫時保留目標圖表，重複 history --from 直到 from_reached，再抓 bounded range，最後還原原商品。
連續沒有進展或 more=false 不能證明耗盡；本 request 已找到 loading 與 endOfData 訊號，
正式修正應依 [System design](./SYSTEM_DESIGN.md)，不將多次重試當成長期解法。
