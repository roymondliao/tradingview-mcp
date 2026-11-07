# History Early Stop Test Plan

Status：`planned`。本文件是修正後驗收計畫；已執行結果只記在 [VERIFICATION.md](./VERIFICATION.md)。
所有 TASK-002～005 尚未執行，不以過去 27/27 baseline 取代本次回歸測試。

## Unit and adapter coverage

新增／更新 tests/data/unit 下的 history-runtime、history-loader 與既有 history 測試。
使用可控制的 monotonic clock、sleep 與排程事件，避免依賴真實等待時間。

| ID | 情境 | 必須斷言 | 責任 |
| --- | --- | --- | --- |
| U01 | request 返回 undefined；loading=true、more=false，之後較舊 bars 到達 | 等待到 settled，只有一次請求，沒有提前完整。 | TASK-003 |
| U02 | 訂閱後請求同步觸發完成 | 不漏事件；baseline 取自發送前。 | TASK-002 |
| U03 | Promise resolve 但資料仍 loading；Promise rejection | resolve 不代表完成；rejection 有錯誤且不出現 unhandled rejection。 | TASK-002 |
| U04 | loaded/end=false/more=true，之後到達 from | 多頁直到 from；去重、篩選及順序正確。 | TASK-003 |
| U05 | end=true/type=end/loading=false，more 仍 true | 直接來源耗盡，不額外發送請求。 | TASK-003 |
| U06 | end=true 但 loading=true | 不接受殘留耗盡訊號，等待 settled。 | TASK-003 |
| U07 | isCompleted=true 同時 loading=true | isCompleted 不影響判斷。 | TASK-003 |
| U08 | 完成事件、loading=false，first_time 不變、end=false | no_progress／complete=false，不忙迴圈或重送。 | TASK-003 |
| U09 | more=false、loading=false、end=false，沒有完成證據 | 等待到 timeout，不誤報 no_more_data。 | TASK-003 |
| U10 | 事件不可訂閱，但狀態／資料稍後完成 | 輪詢成功；不依賴事件必然到達。 | TASK-002／003 |
| U11 | 必要方法不存在、拋錯或回非布林；未知 end type | 明確 unsupported；不能默認 false。 | TASK-002／003 |
| U12 | 初始 loading／零 bars；已耗盡的零 bars | 前者等待；後者可確認空結果。 | TASK-003 |
| U13 | timeout 前剛完成、deadline 時仍 loading、超時後才完成 | 不提前超時、不接受過期結果、不延長 deadline。 | TASK-003 |
| U14 | 每次都有進展，但整體 deadline 到期 | history_timeout；不因新頁重設整體期限。 | TASK-003 |
| U15 | snapshot 暫失、恢復；一直不可讀 | 可恢復讀取或 read_failed；CDP 例外維持原錯誤。 | TASK-003 |
| U16 | 只增加最新 bar／total_loaded | 不誤認較舊資料進展。 | TASK-003 |
| U17 | request 前同頁狀態改變、source 被換掉 | 原子重檢不發送；source mismatch 明確失敗。 | TASK-002 |
| U18 | 完成事件重複或前一輪遲到，loading 仍 true | 不清除 pending、不開始重疊請求。 | TASK-002／003 |
| U19 | observer 初始化一半失敗、重複 close、lease 過期 | 每個 listener 正確解除；舊 token 不再使用。 | TASK-002 |
| U20 | 事件錯誤與 bars 到達同時發生 | 錯誤優先；不輸出假成功或直接耗盡。 | TASK-003 |
| U21 | 收集 bars 時來源／loading 改變 | 不混入異商品資料，回到等待或 conflict。 | TASK-002／003 |
| U22 | from/to 邊界、無 from、maxBars 超過／剛好等於、maxRequests | 保留既有語意；截斷不能 complete=true。 | TASK-003／004 |

## Public contract and lifecycle

| ID | 情境 | 驗收 |
| --- | --- | --- |
| I01 | 尚未到目標且區間內零 bars | timeout／incomplete 錯誤 code 及 retryable 正確，不用 range-empty。 |
| I02 | 確認來源耗盡且零 bars | HISTORY_RANGE_EMPTY、retryable=false；保留 start/date range 訊息差異。 |
| I03 | 超過 limit 且零 bars | HISTORY_LIMIT_REACHED，不建議無條件重試。 |
| I04 | 已有部分 bars，之後 timeout／no_progress | success=true、complete=false、正確 stop_reason；CLI 輸出契約不變。 |
| I05 | CLI 與 MCP 同一 typed error | 保留 code/kind/phase/stage/retryable；MCP isError=true。 |
| I06 | include-bars／output／force | 內容與 metadata 一致，仍防覆寫；失敗或還原失敗不寫出假成功檔案。 |
| I07 | 成功、部分結果、例外、timeout、no-restore | observer 均清理；只按規則還原本次 mutation。 |
| I08 | 外部使用者改商品或週期 | HISTORY_CONTEXT_CHANGED，不混資料、不覆蓋使用者的新選擇。 |
| I09 | cleanup／restore 失敗，含原操作也失敗 | 不回 success；主因保留，清理次數有界，lock 仍釋放。 |
| I10 | 併行 getHistory／quote | 現有 process lock 序列化；不宣稱跨 process isolation。 |
| I11 | TWSE 與 TWSE_DLY alias、D 與 1D | 正確綁定解析後身分；readiness timeout 不被忽略。 |
| I12 | 非法日期與安全上限 | 在連線／切換前拒絕；既有日期契約不變。 |

I01～12 由 TASK-004 負責；需要的狀態機基礎測試在 TASK-003 同步完成。
MCP 可使用假的 server registration 呼叫 history handler 驗證 JSON result，無需連 Desktop。

## Local execution

依 repository runner 規則，把測試放在正式 tests/，不保留 changes/ 下的一次性 scripts。

```bash
npm run test:module -- data
npm run test:module -- cli errors
npm run lint
npm test
git diff --check
```

先跑變動模組，再於整合完成後跑一次全套 local tests；若無新變更或失敗，不重複擴測。
測試數以實際 runner 結果填入驗證文件，不預先承諾數字。

## Desktop acceptance

以受支援 Node 與已啟用 CDP 的 Desktop 執行，記錄實際版本、商品、週期與目標 pane。
在 stg 使用單一 pane；測試前保存商品、週期、chart type、study IDs／names、visible range、
barSpacing／rightOffset。每組 finally 還原並讀回比對。

| ID | 操作 | 修正後預期 |
| --- | --- | --- |
| L01 | 從其他商品、新鮮約 300 根的 INDEX:TAIEX／1D，單次 history 抓 2014-12 | 同一次呼叫完成分頁、23 根、from_reached；不依賴手動重跑。 |
| L02 | 同樣新鮮圖表，只傳 from=2014-12-01 | 涵蓋 from；不能 300 根就 no_more_data。末尾筆數依當日行情變動。 |
| L03 | 6902 新鮮日線，指定 from 早於 2023-07-13 | loading→progress→exhaustion；最早日期 2023-07-13，no_more_data／complete=true。 |
| L04 | 6902 上市前整段區間 | HISTORY_RANGE_EMPTY，不是 HISTORY_LOAD_TIMEOUT。 |
| L05 | 6902 上市當日／跨上市日 | 分別 1／2 根；正確範圍與完整性。 |
| L06 | 初始已載滿 6902，無 from 抓可用全部資料 | 識別既有耗盡，不多發請求；不硬編碼歷史總根數。 |
| L07 | maxRequests=1 且目標仍很遠 | 等該請求 settled 再停止；部分結果及 max_requests，不提前 no_more_data。 |
| L08 | 可訂閱事件與 polling metadata 比對 | 完成／耗盡判斷一致；完成後沒有持續累積 listener。 |
| L09 | success、empty-range、no-restore | observer 清理與圖表還原符合設定；no-restore 由外層測試 finally 還原。 |

建立新鮮圖表的方法沿用 [驗證手法](./VERIFICATION.md)：必要時縮小到近期視野，再切換商品。
若資料預先已載滿，該輪不能算 L01／L03 的分頁驗證。

timeout、網路錯誤、未知 end type 主要用 fake runtime 精確測試，不為了 live 驗收
修改 TradingView server、攔截資料或破壞使用者網路。未實測的 failure cases 必須標明是單元覆蓋。

## Completion gate

TASK-005 完成條件：相關單元／整合與全套 local tests 通過，L01～09 已執行並記錄
結果、方法、版本與還原比對；限制有明確說明。只保存文字與必要摘要，不保留原始行情、
JSON trace 或一次性 scripts。若 live 條件不可用，標示未完成，不能用 mocked PASS 取代。
