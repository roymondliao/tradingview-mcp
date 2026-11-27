# Low-level design

## 頁面 API 取得

在 `src/connection.js` 加入可直接由 CDP 執行的共用 Replay 探測函式。函式只依賴圖表頁面的 `globalThis.TradingViewApi` 和傳入參數，CDP 回傳的資料為可序列化的能力、狀態或錯誤分類。

1. 先讀 `_replayApi`。若已經有實例，直接使用，涵蓋已初始化的現行版和只提供快取欄位的舊版。
2. 快取為空且 `replayApi` 是函式時，在原本的 `TradingViewApi` receiver 上呼叫並等待完成。接著讀回 `_replayApi`，確認既有命令可使用的路徑已就緒。
3. 找不到可用入口回報 `PROVIDER_UNAVAILABLE`。存取器拒絕或完成後未填入快取回報 `PROVIDER_INITIALIZATION_FAILED`。沿用 CDP 的既有等待上限、取消與連線錯誤處理。
4. 探測可獨立檢查指定方法或讀取 `isReplayAvailable()`、`isReplayStarted()`。兩者可能回傳 boolean 或 WatchedValue，讀取後驗證型別。能力探測只確認方法存在，狀態探測才呼叫讀取方法。

`getReplayApi()` 在取得成功後回傳既有頁面運算式 `window.TradingViewApi._replayApi`。六個 Replay Core 指令共用這個入口。探測所需的唯一初始化動作是呼叫 TradingView 自己的存取器，沒有工具列點擊，也不建立 Replay 或交易工作階段。

## 相容性與診斷

- `REPLAY-001` 的兩項斷言在 checker 選定的同一個圖表 CDP target 上執行共用探測。保留 fixture、斷言 ID 和覆蓋範圍。報告標示兩種 Replay 入口，區分入口不存在、初始化失敗、方法缺失和狀態格式錯誤。
- `tv discover` 與 `tv ui-state` 呼叫共用探測。`discover` 回報 Replay API 是否可取得，`ui-state` 回報目前圖表是否支援 Replay 和是否已啟動。其餘診斷欄位可繼續回傳。
- 更新實作識別中的 checker 與 adapter revision，讓舊實作產生的驗證重新執行。相容性報告 schema 與斷言 ID 沿用既有版本。

## 驗收

- 離線測試涵蓋非同步初始化、舊版快取、缺入口、初始化拒絕，以及能力與狀態獨立判定。
- 在 Desktop 3.5.1 上分別從 `_replayApi === null` 開始驗證 `tv replay status` 與 `tv compatibility check`。使用 repo fixture 時目標為 30 項通過、7 項排除，且 `tv compatibility status` 為 `passed`。
