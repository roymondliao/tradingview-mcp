# History Early Stop Low Level Design

Status：`implemented`。與 [System design](./SYSTEM_DESIGN.md) 一起作為驗收依據。
下列型別為設計介面；實際仍使用 repository 的 JavaScript modules。

## Runtime interface

```ts
type HistorySnapshot = {
  identity: { symbol: string; resolution: string; sourceMatches: boolean };
  first_time: number | null;
  last_time: number | null;
  total_loaded: number;
  loading: boolean;
  more: boolean;
  end_of_data: boolean;
  end_of_data_type: string | null;
  events: { loading: number; completed: number; dataLoaded: number; error: number };
  bars?: Bar[];
};

interface HistoryRuntime {
  now(): number; // monotonic milliseconds
  sleep(ms: number): Promise<void>;
  openObserver(expected, deadline): Promise<{ token: string; capabilities }>;
  readSnapshot(token, { beforeTime?, includeBars, deadline }): Promise<HistorySnapshot | null>;
  requestMore(token, { count, expectedFirst, deadline }): Promise<{ issued: boolean; baselineEvents }>;
  closeObserver(token, deadline): Promise<void>;
}
```

getHistory 公開 options 不變；_deps 可注入 runtime、now、sleep、timeout policy。
現有測試以新的 runtime fixture 表達非同步載入，不將缺少 loading/end 等欄位的舊 mock
偷偷補成 false。正式 runtime 的必要能力為 bars、requestMoreData、requestMoreDataAvailable、
isLoading、endOfData、endOfDataType；回傳型別無效也屬 unsupported。

## Observer ownership

1. 切換完成後，openObserver 在一次 page evaluate 中擷取 chart widget／mainSeries 參照，
   驗證必要能力，建立唯一 operation token，註冊可用的 loading／completed／error／onDataLoaded。
2. page registry 使用 client 專用命名空間，不改寫 Desktop 方法；保存 source 參照、事件計數、
   unsubscribe closures、lastTouched 與 disposed。初始化部分失敗時也解除已註冊 listener。
3. 每次 snapshot 在同一次 evaluate 讀取身分、狀態及事件計數，避免跨呼叫拼出互相矛盾的狀態。
   sourceMatches 同時檢查 widget／series object identity 與已解析的商品／週期。
4. requestMore 在同一次 evaluate 再檢查 sourceMatches、loading=false、more=true、尚未耗盡，
   並確認 first_time 仍等於 expectedFirst。若條件改變，issued=false，回到 Inspect，不能盲目發送。
5. 保存當下事件 baseline，再呼叫 requestMoreData；即使事件同步發生也不會漏掉。
   回傳 Promise 時附 rejection handler 保存 source error，不能等待它才開始讀取 observer。
6. listener 只增加計數／保存有界錯誤摘要，不在 listener 中讀全部 bars 或再送請求。
   不把事件 payload、原始 chart object 或私有資料序列化到 CLI。
7. readSnapshot／requestMore 續租 observer。page 端每 5 s 檢查 lease，30 s 未續租即
   unsubscribe 並刪除 registry entry；closeObserver 可重複呼叫，缺失 token 視為已清理。
   lease 過期後不得用舊 token 發請求；Node 回報 HISTORY_OBSERVER_EXPIRED。

事件是同一 series 的觀察資訊，並非 server request correlation。若有外部同商品分頁，
可能無法分辨是哪個 caller 的請求；只接受符合當前來源且由實際 snapshot 證實的資料進展。

## Identity and chart setup

沿用 symbolIdentitiesMatch 處理 TWSE:6902 與 TWSE_DLY:6902 等解析差異。
解析後綁定實際 symbol／resolution，後續讀取嚴格維持該身分及物件參照。
history local resolution comparison 將 D/W/M 等單位縮寫正規化為 1D/1W/1M；
不改寫任意 resolution，也不擴大修改全專案 wait helpers。

setChart 使用有期限的 symbol／resolution API readback，不再呼叫原本會忽略 false 的
waitForChartReady UI helper；檢查期限受整體 deadline 約束。readback 只確認身分，
實際資料 readiness 仍由 loader 的 mainSeries.isLoading 判斷。
初始 bars 為空且 loading=true 時先等待；穩定耗盡且 bars 為空仍可確認真正空區間。

## State variables and predicates

```text
logical states: INSPECT | REQUEST | WAIT | DONE | PARTIAL | FAILED
implementation: snapshot + pending + stopReason (no separate mutable enum)
barsByTime, snapshot, requestsMade, stopReason
operationDeadline, waitDeadline
pending: null | { previousFirst, baselineEvents, observedLoading, issued }

settled(s) = s.loading === false
exhausted(s) = settled(s) && s.end_of_data === true && s.end_of_data_type === 'end'
progress(s,p) = p.previousFirst != null && s.first_time != null
                && s.first_time < p.previousFirst
initialDataArrived(s,p) = p.previousFirst == null && s.first_time != null
covered(s) = fromTime != null && s.first_time != null && s.first_time <= fromTime
completionObserved(s,p) = completed/dataLoaded count increased since baseline
                          OR (p.observedLoading && settled(s))
```

所有判斷先檢查來源身分及 observer error；has error 不得被 covered/exhausted 掩蓋。
isCompleted()、more=false、事件單獨到達、Promise resolve 都不等於 settled completion。
只有 total_loaded 增加但 first_time 不變，不能作為 backward progress。

## Transition algorithm

INSPECT／WAIT 每次先取得不含 bars 的輕量 snapshot，再依需要讀增量 bars。
初始收集所有已載入 bars；之後以「最後已收集的 first_time」為 beforeTime，僅讀更舊資料。
只在 settled 且身分仍相同時收集，確保進入輸出 Map 的資料沒有混入新商品。
包含 bars 的讀取必須同時回傳該次原子 snapshot 的 identity/loading/events；若與先前 metadata
不同，依最新 snapshot 重新判斷。loading=true 的 bars 不加入 Map，來源不同則直接失敗。
不能先確認 metadata 後就無條件接受另一個 CDP 呼叫取回的 bars。

判斷順序如下；每個新的資料 snapshot 都先收集再依序判斷：

1. source mismatch、錯誤事件或 runtime exception → FAILED。
2. 若 loading=true → WAIT，更新 observedLoading；不接受殘留 endOfData／completion event。
3. 若 settled → 讀取該次增量 bars，依日期篩選並以 time 去重。
4. 有效區間筆數大於 maxBars → PARTIAL/max_bars（即使 covered 也不能宣稱完整）。
5. covered → DONE/from_reached；否則 exhausted → DONE/no_more_data。
6. end_of_data=true 但 type 非 end → PARTIAL/unsupported_end_state，不再要求更多資料。
7. requestsMade 已達 maxRequests，且沒有未確認的 pending request → PARTIAL/max_requests；有效筆數等於 maxBars → PARTIAL/max_bars。
   pending 是否已確認由 settled 加 progress／completionObserved 判斷；不能只因數量已達上限而提前返回。
8. 有 pending 且 progress/initialDataArrived → 清除 pending，回 INSPECT。
9. 有 pending，completionObserved 且無進展／未耗盡 → PARTIAL/no_progress。
10. 有 pending 但完成仍不明 → WAIT，即使 more=true 也不重複發送。
11. 無 pending，settled 且 more=true → REQUEST；否則 WAIT 等狀態可用。

REQUEST 在 runtime 中原子地重新檢查；issued=true 才增加 requestsMade，設定 pending
與 waitDeadline。issued=false 回 INSPECT，沿用本次等待 deadline，避免不停重設期限。
issued=false 也須經過一次有界 poll sleep，避免在狀態競爭下形成沒有等待的忙迴圈。

WAIT 每次最多 sleep(min(250 ms, remaining))，events 只作下一次 poll 的判斷資訊。
初始正在載入／暫不能請求也有 waitDeadline；不是只有我們送出的 request 才會 timeout。
觀察到 progress 且 settled 後，下一個實際 request 才開始新的單次等待期限。

讀不到 snapshot 時可在既有期限內重讀，不送新請求；deadline 到期時：
整體期限優先 history_timeout，其次最後 snapshot 不可讀為 read_failed，否則 load_timeout。
deadline 已過不再送新的 CDP 讀取或請求；期限內開始的讀取若期限後才返回，也不當作準時完成。

## Time budget

| 政策 | 預設 | 起算與限制 |
| --- | ---: | --- |
| pollIntervalMs | 250 | metadata 輪詢，不是 request 重試。 |
| loadTimeoutMs | 10,000 | 首次等待或一次成功 issued 時起算，不因事件延長。 |
| historyTimeoutMs | 120,000 | 取得 process lock 後、讀原圖表前起算；包含準備／切換／讀取。 |
| cleanupTimeoutMs | 15,000 | 資料操作結束後的額外總預算，包含 observer 清理與圖表還原。 |

使用 evaluate(expression, {awaitPromise, timeout_ms})；每次 timeout_ms 為
min(CDP_TIMEOUTS.command, 當前剩餘預算)，不能使用無法傳 timeout 的 evaluateAsync wrapper
來等待整個載入操作。整體 deadline 是 client 資料操作期限，不包含等 lock 的排隊時間；
最終返回可能另加 cleanup 預算。Node timeout 不會取消已送往 Desktop 的 JavaScript／網路請求。

## Output and errors

保留現有 sort、inclusive from/to、ISO companions 與 maxBars 裁切規則。
complete 僅由 from_reached／no_more_data 決定，且任何實際截斷都必須覆寫為 false。
無 from 時只能用確認耗盡宣告完整；不能因收到一批資料就完成。

有 bars 的可恢復停止條件回傳部分結果；空 Map 則使用下表。
所有新 error 使用 CoreOperationError，phase=history_load，stage 保存具體停止原因，
timeout_ms 只在 timeout 時提供。kind 使用現有 enum，不新增全域錯誤分類。

| 情況 | code | kind | retryable |
| --- | --- | --- | --- |
| from_reached／no_more_data 後仍無符合 bars | HISTORY_RANGE_EMPTY | validation | false |
| load_timeout／history_timeout | HISTORY_LOAD_TIMEOUT／HISTORY_TIMEOUT | internal | true |
| no_progress／read_failed | HISTORY_LOAD_INCOMPLETE | internal | true |
| max_bars／max_requests 且空結果 | HISTORY_LIMIT_REACHED | validation | false |
| unsupported_end_state 且空結果 | HISTORY_END_STATE_UNSUPPORTED | internal | false |
| 必要狀態 API 缺失或型別錯誤 | HISTORY_RUNTIME_UNSUPPORTED | internal | false |
| observer lease 過期 | HISTORY_OBSERVER_EXPIRED | internal | true |
| 商品／週期／source object 改變 | HISTORY_CONTEXT_CHANGED | conflict | false |
| 無法分類的來源 error 事件／request rejection | HISTORY_SOURCE_ERROR | internal | false |
| 清理／還原失敗 | HISTORY_CLEANUP_FAILED／HISTORY_RESTORE_FAILED | internal | false |

retryable=true 只表示可稍後再試；本次不自動 retry。
已正規化的 CDP、interrupt、symbol switch 等錯誤保留原 code/kind/retryable/cause，
不轉成 HISTORY_LOAD_INCOMPLETE。來源錯誤 payload 尚未確認，先採不自動重試的保守分類。
HISTORY_RANGE_EMPTY 的訊息保留原本 start time／date range 文字；未完成則清楚表示
尚未確認要求的歷史範圍，不沿用 No historical bars matched。

CLI 使用現有 router 標準診斷；MCP history catch 改成 coreErrorResult(err)，
保留 success=false/error/isError 並增加 code、kind、phase、stage、retryable 等現有可序列化欄位。
不另加任意 details 欄位，避免被 CoreOperationError context allowlist 丟棄。

## Cleanup ordering

內層 finally 關閉 observer；外層 finally 還原本次 mutation 並釋放 chart data lock。
所有嘗試都受 cleanupDeadline 控制；observer 關閉失敗仍要嘗試還原。
主操作失敗加清理失敗時，以 cleanup/restore error 為外層、原錯誤作 cause，不能丟失主因。
主操作成功但還原失敗時不能回傳 success；output 寫檔仍在 getHistory 完成之後。

還原前先檢查 pane 仍是本次擁有的 requested context；外部已更改則跳過 mutation，
回報 HISTORY_CONTEXT_CHANGED。no-restore 不還原商品／週期，但仍解除訂閱。
client 非正常終止依賴 observer lease 清除 listener；無法保證 process 被殺後仍能還原圖表。

## Test seams

狀態機使用 fake monotonic clock 與可排程 snapshots/events，不依真實 sleep 斷言時序。
runtime adapter 另測訂閱先於請求、同步完成、原子重檢、Promise rejection、lease 清理及短 CDP deadline。
不從測試 import production 私有字串來生成期望值；以行為斷言 requests、資料範圍、complete、
error code、清理次數與沒有重疊請求。完整矩陣見 [Test plan](./TEST_PLAN.md)。

## Implementation notes

- Adapter 以可序列化、self-contained page operation 實作；正式 adapter 與 VM 測試執行同一函式。
- 結構化 source errors 不記錄未驗證的事件 payload；Promise rejection 以 error counter 呈現。
- Deadline 在迴圈檢查與 adapter preflight 間到期時，loader 保留 partial bars 並回 timeout；
  真正 CDP 錯誤仍保留原分類。
- 單次等待的預算不因 send 被原子重檢拒絕而延長。maxRequests 必須等最後一次已送出請求
  settled 後才生效；這避免另一種「請求已送出但尚未載入就返回」的情形。
- history 公開呼叫仍透過既有 process lock；quote 入口及鎖未修改。
