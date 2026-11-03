# History To Low Level Design

Status: `done`。TASK-001 與 TASK-002 已依本設計完成實作、規劃的本機自動化驗證
及使用文件；結果見 [驗證紀錄](./DELIVERY_EVIDENCE.md)。
元件與資料流程見 [System design](./SYSTEM_DESIGN.md)。

## File changes

| File | Planned change |
| --- | --- |
| `src/core/data.js` | 共用日期 parser、匯出純 range validator、接受 `to`、範圍內累積與輸出 metadata。 |
| `src/cli/commands/data.js` | 註冊 `to`、help，以可隔離測試的 handler 執行日期 preflight，傳遞原始 `from`／`to`。 |
| `tests/data/unit/history.test.js` | 日期、區間、分頁、限制、錯誤、還原及檔案輸出測試。 |
| `tests/cli/integration/router.test.js` | help、必要參數、日期錯誤與不連線驗證。 |
| `README.md` | CLI 範例、日期零時及明確時區說明。 |

不新增 runtime dependency；`src/tools/data.js`、`src/core/time.js` 與共用 Pane wrapper 無需修改。

## Shared date parsing

將私有 `parseHistoryFrom(value)` 改名為 `parseHistoryDate(value, name)`。
保留原有分支與運算，僅把錯誤訊息的 `from` 改為參數名稱。

```js
function parseHistoryDate(value, name) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error(`Invalid ${name} value: ${value}`);
    return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric);
  }
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid ${name} date: ${value}`);
  return Math.floor(timestamp / 1000);
}
```

此 change 不擴充數字字串格式、不調整毫秒判斷門檻、不更換 `Date.parse()`，
也不加入更嚴格的曆日 parser。無效日期指既有 parser 無法辨識的輸入；
JavaScript 原本接受或正規化的格式維持原有結果。

| Example | Normalized meaning |
| --- | --- |
| `2026-06-30` | `2026-06-30T00:00:00Z`，不代表整天。 |
| `2026-06-30T23:59:59+08:00` | `2026-06-30T15:59:59Z`。 |
| `1782863999` | 依既有數字字串分支解析成 Unix 秒。 |
| `1782863999000` | 大於 `1e12`，除以 1000 後向下取整成 Unix 秒。 |

省略 offset 的日期時間仍依 Node 執行環境解析；文件與測試以明確 offset 為主。

## Range validation

在 `data.js` 匯出 `normalizeHistoryRange({ from, to } = {})`，回傳
`{ fromTime, toTime }`。CLI 與 loader 共用此純函式；它不讀圖表、不建立 runtime、
不寫檔，也不查系統時間。

驗證順序如下：

1. `to != null` 表示有提供上界。若此時 `from` 為 null、undefined、空字串或純空白，
   拋出 `--to requires --from`。數字 `0` 是有效輸入，不可用 truthiness 判斷。
2. 使用 `parseHistoryDate(from, 'from')` 解析起點。
3. 使用 `parseHistoryDate(to, 'to')` 解析終點。若有提供 `to` 但解析結果為 null
   （例如 `to: ''`），拋出 `Invalid to date: ...`，不默默當作省略。
4. 兩端皆存在且 `fromTime > toTime` 時，拋出 `from must be less than or equal to to`。
5. 回傳結果。等於端點、過去或未來的日期皆沿用區間規則；不另外禁止未來日期。

未提供 `to` 時，`from` 的空值／日期行為維持現有 parser 語意。
反向區間依轉成 Unix 秒後的值判斷，與 bar 比較使用相同精度。

### CLI validation boundary

新增 option，不配置新的短旗標：

```js
to: { type: 'string', description: 'Latest ISO date or Unix timestamp (requires --from)' }
```

Handler 保留 removed-options 檢查，接著在 `withPaneContext()` 前執行：

```js
core.normalizeHistoryRange({ from: opts.from, to: opts.to });
```

通過後才準備 context，並將 `to: opts.to` 與原始 `from` 一併傳入 `getHistory()`。
不以 truthiness 丟棄空值，讓 validator 能拒絕明確傳入的空 `to`。
既有 router 的本機 compatibility advisory 可以先執行；日期 preflight 應早於
CDP discovery、Tab attach、Pane focus、圖表讀取及 symbol/timeframe 切換。

為直接測試此順序，將原有 handler 的本體移至同檔匯出的
`runHistoryCommand(opts, deps = {})`，註冊時使用 `handler: opts => runHistoryCommand(opts)`。
`deps` 僅提供測試替身，預設為現有實際函式：

```js
// deps defaults
normalizeRange = core.normalizeHistoryRange;
withContext = withPaneContext;
getHistory = core.getHistory;
writeOutput = writeHistoryOutput;
```

此 helper 保留原有 options 轉換與檔案輸出流程，不新增 CLI 參數或 production 分支。
測試可傳入 spies 驗證先驗證、後 context、再讀取及輸出的順序。

### Core validation boundary

`_getHistoryInternal()` 新增 `to` 參數，在既有 safety-limit 驗證後呼叫同一個
`normalizeHistoryRange()`，取得 `fromTime` 與 `toTime`，再建立 runtime 並讀取 chart state。
保留 `getHistory()` 的 `withChartDataLock()`；直接 core 呼叫不能繞過驗證。
CLI 的重複純驗證是為了覆蓋 Pane context 邊界，無需額外暴露已驗證物件或 skip 旗標。

## Range predicate and accumulation

在 loader 中定義一次 predicate，供累積與最終輸出使用：

```js
const inRange = time =>
  (fromTime == null || time >= fromTime) &&
  (toTime == null || time <= toTime);

const addBars = bars => {
  for (const bar of bars || []) {
    if (bar?.time == null) continue;
    const time = Number(bar.time);
    if (inRange(time)) barsByTime.set(time, bar);
  }
};
```

Map key 沿用數值時間戳，同時間的 bar 由後讀入者覆蓋。
只保留區間內 bars 後，原本 `relevantBarCount()` 可由 `barsByTime.size` 取代。
未設定 `to` 時，這與原本先累積、依 `from` 計數及最終篩選的結果相同。

來源 snapshot 仍保留未經區間篩選的 `first_time`、`more`、symbol 與 resolution。
初始 source snapshot 缺失或沒有 bars 仍走原有讀取錯誤；
初始 snapshot 有 bars 但 Map 為空則繼續正常分頁，不立即回報無資料。
來源 `first_time` 向前移動但本批沒有符合區間的 bar，仍屬有效進展。

不變更 `historyRuntime().readSnapshot(beforeTime)` 的 CDP projection，
也不將 `to` 當作 runtime 的 `beforeTime`。後者是分頁去重邊界，不能替代輸出篩選。

## Paging and stopping order

保留目前 while loop 的判斷順序，以免此 change 改變既有 `complete` 行為。
以下 N 為區間內 Map 的筆數：

| Priority | Condition | Stop reason | Complete |
| --- | --- | --- | --- |
| 1 | `N > maxBars` | `max_bars` | `false` |
| 2 | 有 `from` 且來源 `first_time <= fromTime` | `from_reached` | `true` |
| 3 | 來源 `more === false` | `no_more_data` | `true` |
| 4 | `requestsMade >= maxRequests` | `max_requests` | `false` |
| 5 | `N === maxBars` | `max_bars` | `false` |

若未停止，執行既有 request/poll：

1. 保存來源的 `previousFirst`，呼叫 `requestMore(barsPerRequest)`，增加 request 計數。
2. 沿用 `readSnapshot(previousFirst)` 與 polling 次數／間隔。
3. 回傳 snapshot 缺失或 `first_time` 缺失時，停止為 `read_failed`。
4. 將新 bars 交給 `addBars()`；來源未向過去移動且未耗盡時，停止為 `no_progress`。
5. 更新來源 snapshot，回到 while loop。

`read_failed`／`no_progress` 皆為 `complete: false`。
Runtime 拋出的 exception 沿用原有錯誤傳遞，不轉成成功結果。
`max_bars` 是結果上限，單次 snapshot 可能先超量再裁切；不新增任意提早截斷。
若 N 剛好等於上限且已涵蓋 `from`，沿用優先序回傳 `from_reached`；
若超過上限，即使已涵蓋 `from` 仍回傳 `max_bars`，反映資料被裁切。

### Example across newer data

```text
from = 250, to = 400, max_bars = 2
initial source: first_time=500, bars=[500,600], more=true
  → retained=[], count=0; request older data
next source: first_time=200, bars=[200,300,400], more=true
  → retained=[300,400], count=2
  → first_time <= from; stop=from_reached, complete=true
```

較新的 500／600 不占用筆數；較舊的 200 仍用於證明來源涵蓋起點，但不輸出。

## Result construction and errors

最終流程沿用排序與保留最新 N 筆，使用同一個 predicate：

```js
let bars = [...barsByTime.values()]
  .sort((a, b) => a.time - b.time)
  .filter(bar => inRange(Number(bar.time)));
if (bars.length > maxBars) bars = bars.slice(-maxBars);
```

空集合在產生 `period` 前拋錯。提供 `to` 時使用
`No historical bars matched the requested date range.`；未提供 `to` 時保留原有
`No historical bars matched the requested start time.`，減少既有錯誤訊息變動。
即使是 request limit 導致尚未走到區間，無匹配資料仍依既有空集合行為報錯。

其餘結果建構保留，新增：

```js
requested_to: toTime,
requested_to_iso: unixSecondsToIso(toTime),
```

| Field | Source |
| --- | --- |
| `requested_from`／`requested_to` | 解析後的使用者端點；未提供者為 null。 |
| `requested_from_iso`／`requested_to_iso` | 對應端點的 Unix 秒轉 ISO。 |
| `period.from`／`period.to` 及 ISO 欄位 | 最終 bars 的第一筆／最後一筆。 |
| `bar_count` | 最終 bars 長度。 |
| `bars` | 僅在 `include_bars` 為 true 時附帶，使用既有 `time_iso` 補值。 |
| `complete`／`stop_reason` | 既有停止判斷，不因末筆早於指定 `to` 而自行判定失敗。 |

錯誤沿用 `Error` 與現有 CLI JSON diagnostic／exit code 路徑，不新增 history 專屬錯誤框架。
輸出寫入仍在 core 完成並執行既有 finally 還原後進行；不因新增 `to` 提前建立檔案。
`--no-restore`、`--output`、`--include-bars` 與 `--force` 的現有語意保持不變。

## Verification plan

以現有 `_deps` 模擬來源資料，避免測試依賴真實市場時間、交易日或 Desktop。

| Area | Required cases |
| --- | --- |
| 必要參數 | `to` 缺 `from`、空字串／純空白 `from`；Unix `0` 不視為缺少。 |
| 日期解析 | 純日期 UTC 零時、明確 offset、Unix 秒／毫秒、不可解析值、空 `to`。 |
| 區間 | `from > to` 拒絕、相等時包含端點、精確時間上下界、未匹配結果報錯。 |
| 無 `to` 相容 | 只傳 `from` 仍保留最新可用 bars；兩端皆省略仍沿用全部歷史模式。 |
| 假日 | 指定範圍內最後交易日早於 `to`，輸出保留實際 `period.to`。 |
| 分頁 | 初始整批晚於 `to`、中間多批仍無匹配但來源有進展、最後跨越 `from`。 |
| 去重與筆數 | 重複時間戳、區間外不計數、區間內超量保留最新 N 筆、相等與超量的停止優先序。 |
| 停止與失敗 | `no_more_data`、`max_requests`、`max_bars`、`read_failed`、`no_progress` 及 runtime exception。 |
| Context 與還原 | 日期錯誤不呼叫 runtime；有效呼叫成功或失敗時維持既有 symbol/timeframe 還原。 |
| 輸出 | Metadata-only、包含 bars、檔案與 stdout summary 的端點／筆數一致；防覆寫不變。 |

CLI help 與無效參數使用 `tests/cli/integration/router.test.js` 的 subprocess 路徑。
將 CDP port 指向不可用端點，確認無效日期仍得到參數錯誤而非 CDP 錯誤；
core 測試以會立即失敗的 runtime spies 證明未發生圖表讀取或切換。
有效 CLI 接線在 `tests/data/unit/history.test.js` 直接呼叫 `runHistoryCommand()`，
注入 Pane wrapper、core 及檔案輸出替身，驗證 raw `from`／`to` 傳遞、
preflight 失敗不準備 context，以及成功時的呼叫順序。
沿用 `node:test` 與普通函式注入，不需要 experimental module mock 或真實連線。

預定檢查命令：

```bash
node --test tests/data/unit/history.test.js tests/cli/integration/router.test.js
npm run lint
git diff --check
```

正式實作時記錄實際驗證結果；Desktop live 驗證若執行，另記來源 symbol、timeframe、
requested range、actual period 及停止原因，不以假日是否有新 bar 作為固定預期。
