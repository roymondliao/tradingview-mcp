# History Early Stop Verification

驗證日期：2026-11-07。**缺陷已修正，單元／整合測試與 Desktop 驗收通過。**
下列原始重現記錄保留修正前的結果，修正後結果見文末。
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

## 修正後驗收

日期：2026-11-07。分支 fix/tv-history-early-stop；設計 commit 80185df，驗收對象為其後的實作工作樹。
Node v26.12.1；Desktop 3.5.0；stg／HQJPvW0n／pane 0，單一 pane。
本次開始時使用者圖表已是 BATS:SOXX／1D，因此還原目標以當次讀回狀態為準。

### Implementation delivered

- history-runtime.js：短 CDP 呼叫、必要能力檢查、原子發送、來源綁定、事件訂閱與 lease。
- history-loader.js：以 snapshot／pending／stopReason 表達狀態機；載入、進展、耗盡、上限及 deadline。
- history-errors.js：確認空區間、未完成、timeout、unsupported、來源變更與清理錯誤的分類。
- data.js：保留 chart data lock、輸出契約與 no-restore；加入有界清理及避免覆蓋外部圖表變更。
- CLI help／README 說明完整性；MCP history 保留結構化錯誤。

### Local validation results

| 檢查 | 結果 |
| --- | --- |
| data module | 66/66 通過，含原有 27 cases 與新增 39 cases。 |
| npm test（全套 local unit/integration） | 880/880 通過，133 suites，無 fail／skip。 |
| npm run lint | Exit 0，沒有 error；3 個既存 unused-variable warnings。 |
| git diff --check | 通過。 |

新增測試使用 VM 模擬 Desktop 物件、可控制 clock／事件／資料到達，涵蓋暫時 more=false、
同步完成、Promise rejection、未知訊號、lease 到期、資料讀取競態、來源變更與清理失敗。
不使用真正 sleep 測時間界線。正式 tests 保留在 tests/data/unit 與 support；不保存一次性診斷腳本。

測試過程抓到並修正兩個邊界：maxRequests 到達但最後請求尚未確認時仍須等待；
loop 與 adapter preflight 之間逾時時仍要保留部分結果。全套結果為這些調整後的重新驗證。
同 process 序列化以兩次 history 呼叫測試；quote 沿用未變更的相同 lock，未另做 live 併發操作。

### Desktop acceptance results

| ID | 實際操作與結果 |
| --- | --- |
| L01 | 新鮮 300 根 TAIEX，實際 CLI 單次抓 2014-12：3 次請求、23 根、from_reached、complete=true。 |
| L02 | 新鮮 TAIEX，只傳 from=2014-12-01：3 次請求、2,899 根，最早 2014-12-01，from_reached。 |
| L03 | 新鮮 300 根 6902，from=2023-07-01：1 次請求後 752 根，最早 2023-07-13 01:00 UTC，no_more_data、complete=true。 |
| L04 | 6902 上市前區間：HISTORY_RANGE_EMPTY、retryable=false。 |
| L05 | 上市當日／跨上市日區間分別 1／2 根，no_more_data、complete=true。 |
| L06 | 已載滿 6902，不傳 from：752 根、requests_made=0、no_more_data。 |
| L07 | 新鮮 TAIEX，maxRequests=1：等待載入後回 1,300 根、max_requests、complete=false；返回時 loading=false。 |
| L08 | 以真實 runtime wrapper 只記 metadata：6902 完成後 loading/completed/dataLoaded counters 均為 1，error=0，end=true，與 snapshot 相符。 |
| L09 | 預設還原成功、empty-range 後還原、no-restore 保留目標均符合契約；每個案例完成後 registry observer 數量為 0。 |

L01 使用實際 CLI；其他案例直接呼叫 production getHistory，共用同一 core 與 Desktop adapter。
未在 live 人為製造網路故障或未知 end type，這些由單元測試驗證。

### Repeating the acceptance

1. 讀取目標 pane 的完整狀態與時間軸 spacing／offset，保存在測試執行中的記憶體。
2. 將視野縮至約 60 根，切離再切回測試商品；等待 loading=false，確認初始為約 300 根。
3. 對 TAIEX 執行原始 bounded CLI 命令；這次不要使用手動多次 history 的 workaround。
4. 對各 from-only、6902 邊界與 maxRequests 案例呼叫 production getHistory，斷言上述 metadata。
5. 事件驗證只包裝 runtime.readSnapshot 記錄計數，不替換資料來源或狀態值。
6. 每個案例結束讀取 observer registry 數量；先前訂閱必須全部釋放。
7. 外層 finally 還原原商品／週期，必要時載入原視野的歷史，再還原 spacing／offset，
   比對 symbol、timeframe、chart type、study IDs／names、visible range。

本次還原後為 BATS:SOXX／1D，可見範圍 2023-11-13～2026-11-20，與開始完全一致；
observer 數量為 0。恢復原視野時 loaded bars 由 752 增為 1,300，這是載入批次產生的 cache，
不宣稱將 Desktop 已載入資料量也還原；指標 inputs 未另外比對。

一次性 live 驗收腳本與測試輸出已清除，只保存本節結果及操作方法。
