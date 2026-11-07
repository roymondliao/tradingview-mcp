# History Early Stop Verification

驗證日期：2026-11-07。**已確認缺陷與可用的 Desktop 狀態訊號；尚未驗證修正後行為。**
本文件保留結果與方法，不依賴已刪除的診斷 scripts 或原始輸出。

## Environment

- Base commit 1d933e1，package 1.7.0，Node v26.12.1。
- Desktop observed_version 3.5.0；未執行完整 compatibility audit。
- stg（HQJPvW0n），單一 pane 0；以本機 CDP 操作實際 Desktop。
- TAIEX 驗證前原商品為 TWSE_DLY:IX0001／1D。
- 6902 驗證由使用者指定 watchlist taiex-research；snapshot 確認代碼 TWSE:6902，
  Desktop 解析為 TWSE_DLY:6902。當時 stg 已切到該商品。

## TAIEX early stop

| 項目 | 已觀察結果 |
| --- | --- |
| 新鮮圖表抓 INDEX:TAIEX 2014-12 區間 | Exit 1，CORE_UNCLASSIFIED_ERROR，retryable=false，No historical bars matched the requested date range. |
| requestMoreData(1000) | 同步返回 undefined；more 立即 true→false。 |
| 首次請求後 snapshot | 初始 300 根不變、最早日期不變；history 仍返回 no_more_data／complete=true。 |
| 返回後再次觀察、不另送請求 | 約 254 ms 後觀察到 1,300 根，more=true；不是精確網路耗時。 |
| 保留圖表再呼叫 | 300→1,300→2,300→2,899 根，最後到達 2014-12-01。 |
| 已載入後抓同一區間 | 成功取得 2014-12-01～2014-12-31 共 23 根，from_reached。 |

這確認資料存在，失敗原因是 client 在請求完成前誤判耗盡。
未逐根核對 OHLCV 值，也未在本次驗證 output/include-bars 匯出。

### Reproduction method

1. 記錄 stg 的商品、週期、chart type 與 study IDs／names。初始商品不可是已載滿的 TAIEX。
2. 執行下列原始區間命令，觀察 exit code 與錯誤；預設操作會還原圖表。
3. 透過既有 history core 的 _deps 在 evaluate 層記錄 metadata；使用真實 requestMoreData，
   保留非 Promise 立即返回的既有行為，觀察 first_time、total_loaded、more 與呼叫返回時點。
4. 此次保留目標圖表；history 返回後只讀 metadata，確認先前請求是否稍後帶來舊資料。
5. 重複 history --from、不再傳 symbol，直到 from_reached；再執行 bounded range。
6. finally 還原原商品與週期，重新比對 chart type、study IDs／names。

```bash
node src/cli/index.js history --layout-id HQJPvW0n --pane-index 0 \
  --symbol INDEX:TAIEX -t D \
  --from 2014-12-01T00:00:00Z --to 2014-12-31T23:59:59Z
```

TAIEX 原商品、週期、chart type、指標清單已比對還原；viewport 未納入該輪比對。

## 6902 loading and exhaustion

初始圖表已載入 752 根，最早 bar 為 2023-07-13 01:00 UTC（台北 09:00），
與使用者提供的上市日期一致。縮小視野並切換商品後，取得初始 300 根重新測試。

| 階段 | 根數 | more | isLoading | isCompleted | endOfData | endOfDataType |
| --- | ---: | --- | --- | --- | --- | --- |
| 初始 | 300 | true | false | true | false | null |
| 請求 100 根，載入中 | 300 | false | true | true | false | null |
| 100 根完成 | 400 | true | false | true | false | null |
| 再請求 1,000 根，載入中 | 400 | false | true | true | false | null |
| 到達歷史起點，新增 352 根 | 752 | true | false | true | true | end |
| 再次請求，載入中 | 752 | false | true | true | true | end |
| 完成但無新增資料 | 752 | false | false | true | true | end |

每輪均收到 loading、completed、onDataLoaded 事件；最後沒有新增 bars 的請求也會收到。
最終重跑三輪 completed 約在 102、110、86 ms 被觀察到；這不是 timeout 設定保證。

isCompleted 在 loading 中仍為 true，不能單獨使用。more 在首次到達起點後仍為 true，
不能作為「一定還有舊資料」的證據。endOfData 在下一次 loading 期間也保留 true，
因此必須配合 loading=false 與來源身分判斷。

status() 本次由 2→9；私有 _lastCompleteFlags.data_completed 在耗盡時為 end。
兩者僅作輔助觀察，不列為實作契約。

| 已載滿後的日期區間 | 實際結果 |
| --- | --- |
| 2023-07-01～2023-07-12（日末） | No historical bars matched the requested date range. |
| 2023-07-13 當日 | 1 根，時間 01:00 UTC，no_more_data／complete=true。 |
| 2023-07-01～2023-07-14（日末） | 2 根，07-13／07-14，no_more_data／complete=true。 |

這一輪上市前的空區間是真正沒有資料，與 TAIEX 尚未載入的原因不同。

### Verification method

1. 使用 watchlist snapshot --name taiex-research 確認 symbol；固定 stg／pane 0，確認只有一個 pane。
2. 記錄商品、週期、chart type、study IDs／names、visible range，以及時間軸的 barSpacing／rightOffset。
3. 讀取 mainSeries 的 bars.size、first bar time、requestMoreDataAvailable、isLoading、endOfData、endOfDataType。
4. 若已載滿，暫時以 timeScale.zoomToBarsRange 顯示最近約 60 根，切到其他商品再返回 6902／1D，
   確認初始只載入近期資料。只切換商品而不縮小全歷史視野，可能仍一次載滿。
5. 先訂閱 dataEvents().loading()/completed()/error() 與 chart.onDataLoaded()，再送請求。
   按 100、1,000、1,000 根執行；每輪觀察事件及每 100 ms 的 snapshot 約 3 秒，輪末解除訂閱。
6. 比較送出後、完成事件當下及最後 snapshot。檢查 more／loading／end 與 first_time 的組合，
   不以單一布林值或固定等待秒數推斷結果。
7. 完全載入後，使用未修改的 getHistory 執行上市前、上市當日、跨上市日三個範圍。
8. finally 還原商品／週期，再還原時間軸 barSpacing／rightOffset；重新讀 visible range 比對。

Desktop 的 chart.setVisibleRange() 在本版本拋出 Not implemented。
getVisibleBarsRange() 回傳時間戳，不能直接傳給需要 bar index 的 zoomToBarsRange。
本輪已修正還原手法並重跑：商品、週期、chart type、指標清單與可見日期完全一致，
可見日期為 2023-07-13～2026-11-20，包含右側未來留白。

## Offline reproduction and existing baseline

方法：注入 runtime，排定較舊 bars 稍後到達；request 先返回 true、期間 more=false。
分別呼叫有／無 to 的 history，檢查它是否在資料到達之前返回、是否曾等待，
再等排定資料完成後重新讀取同一區間。

已觀察：兩種情境都在資料到達前返回，sleep 呼叫數為 0；無 to 錯報完整，有 to 報空區間；
資料到達後兩者都能成功取得目標資料。診斷斷言描述的是 bug，不是修正後驗收。

當時執行 `node --test tests/data/unit/history.test.js`，**27/27 通過**。
既有 mock 大多在 request 時同步切換下一份資料，未涵蓋暫時 more=false 的非同步間隙。
這是修正前 baseline，不能當作新設計已通過測試。

## Coverage limits and next verification

已驗證 Desktop 3.5.0 的 TAIEX 與 6902 日線，未涵蓋斷線、未知 endOfDataType、
權限限制、跨 process 請求、其他週期／版本及來源錯誤 payload。
實作後驗收依 [TEST_PLAN.md](./TEST_PLAN.md)；不能只重跑目前已載滿的圖表。
