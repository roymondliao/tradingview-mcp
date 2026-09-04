# TradingView MCP Terminology Definition

本文件定義本 repo 在描述 TradingView Desktop、圖表元件、Pine Script、策略回測資料，以及 MCP／CLI 操作時使用的標準名詞。

新增功能、API 欄位、CLI 指令與文件時，應優先使用本文件中的名詞，避免同一個名稱同時代表 UI 元件、圖表實例與資料集合。

## Application and navigation

- **App（應用程式）**
  - 指整個 TradingView Desktop 應用程式。
  - 本 repo 透過 Chrome DevTools Protocol（CDP）連線至 App。
  - `app` 不應用來指稱單一圖表或分頁。

- **Tab（分頁）**
  - 指 TradingView Desktop 最上方的分頁。
  - 一個 Tab 通常載入一個 Saved Layout，但也可能是 New Tab 頁面。
  - 由 `tab_list`、`tab_switch`、`tab_new` 與 `tab_close` 操作。
  - Tab 不等同於 Pane；一個 Tab 可以包含多個 Pane。
  - 對外定位欄位使用 `tab_index` 或 CDP `target_id`；URL `/chart/<token>/` 中的短碼使用 `url_chart_id`。
  - TradingView 頁面 Title 通常是通用文字，不應作為穩定的 Tab Name 或 Selector。

- **Saved Layout（已儲存版面）**
  - 指儲存在 TradingView 帳號中的 Chart Layout。
  - 可包含商品、時間週期、指標與 Pane Layout 等設定。
  - 由 `layout_list` 與 `layout_switch` 操作。
  - 文件與 API 應使用 `saved_layout`，避免只使用意義不明確的 `layout`。
  - Desktop 3.4.0 的 runtime identity 使用 `layout_id`，值與 Chart URL `/chart/<token>/` 的短碼相同，例如 `LC43xk9j`。
  - 帳號儲存層的數字 ID 使用 `saved_layout_id`，例如 `196567163`；它由 `getSavedCharts()` 中 `url === layout_id` 的項目映射取得。
  - 使用 `layout_name` 表示可讀名稱。名稱可能被重新命名或重複，不可單獨作為精確 Selector。
  - 未儲存、分享或非帳號擁有的 Layout 可能有 `layout_id`，但 `saved_layout_id` 為 `null`。

- **Pane Layout / Grid Layout（圖表格線配置）**
  - 指一個 Tab 內的圖表排列方式。
  - 常見配置包含 `s`（單一 Pane）、`2h`（上下兩個 Pane）、`2v`（左右兩個 Pane）與 `4`（四個 Pane）。
  - 由 `pane_set_layout` 操作。
  - 文件與 API 應使用 `pane_layout`，避免與 Saved Layout 混淆。

## Chart components

- **Pane（圖表窗格）**
  - 指 Pane Layout 中的一格。
  - 每個 Pane 可以有自己的 Symbol、Timeframe、Indicators 與 Drawings。
  - 由 `pane_list`、`pane_focus` 與 `pane_set_symbol` 等操作。
  - 使用 `pane_index` 表示目前 Layout 內的位置，使用 `pane_id` 表示 TradingView Saved Chart Content 中的內部 Chart ID。
  - Pane 沒有可靠的使用者自訂名稱；不定義或產生 `pane_label`，直接回傳 Symbol、Resolution 與 Active State。

- **Active Pane（目前作用中的圖表窗格）**
  - 指目前被選取並接受圖表指令的 Pane。
  - 多數 `chart_*` 與 `data_*` 操作預設作用於 Active Pane。
  - 本 repo 內部通常透過 `_activeChartWidgetWV` 取得 Active Pane。
  - 自動解析無法唯一確認時必須要求 `pane_index`，不可猜測第一個 Pane。

- **Chart（圖表）**
  - 指 Pane 內實際顯示市場資料的圖表元件。
  - Chart 包含 Main Series、Studies 與 Drawings 等資料來源或物件。
  - Chart 不等同於 Tab；一個 Tab 可以包含多個 Chart。

- **Chart State（圖表狀態）**
  - 指 Active Pane 當下的 Symbol、Timeframe／Resolution、Chart Type 與 Studies 等設定。
  - 由 `chart_get_state` 取得。

- **Main Series（主要價格序列）**
  - 指 Chart 中商品本身的價格資料序列。
  - 通常包含 K 線與 OHLCV 資料。
  - Main Series 不同於 Indicator 產生的 Study Series。

- **Market History Data / Chart History Data（市場歷史資料／圖表歷史資料）**
  - 指特定 Symbol 與 Timeframe 的歷史市場行情。
  - 每筆資料通常是一根 Bar，包含 Timestamp、Open、High、Low、Close 與 Volume（OHLCV）。
  - 本 repo 的 `history` 功能透過 Main Series 與 `requestMoreData()` 載入及匯出這類資料。
  - Market History Data 是 Strategy 回測的輸入之一，不是 Strategy 回測產生的買入／賣出交易紀錄。
  - `bars_per_request`、`max_requests` 與 `max_bars` 只適用於 Market／Chart History Data，不適用於 Strategy Trading Data。

- **Symbol（商品代號）**
  - 指股票、期貨、外匯或加密貨幣等交易商品。
  - 應優先使用包含交易所的完整格式，例如 `NASDAQ:AAPL`。
  - 不建議只使用 `AAPL`，以免遇到跨交易所同名商品。

- **Timeframe（時間週期）**
  - 指使用者理解的圖表週期，例如 1 分鐘、1 小時或 1 天。
  - CLI、說明文字與一般文件應優先使用 `timeframe`。

- **Resolution（TradingView 時間週期值）**
  - 指 TradingView 內部使用的 Timeframe 表示值，例如 `1`、`60`、`1D` 或 `1W`。
  - 與 TradingView 內部資料結構對接的程式欄位可保留 `resolution`。
  - 文件第一次出現時應寫成「Timeframe／Resolution」。

- **Chart Type（圖表類型）**
  - 指 Candles、Bars、Line、Area 或 Heikin Ashi 等顯示方式。
  - 改變 Chart Type 不會改變 Symbol 或 Timeframe。

- **Bar / Candle（K 棒／K 線）**
  - 指特定 Timeframe 下的一筆市場資料。
  - 標準欄位為 `time`、`time_iso`、`open`、`high`、`low`、`close` 與 `volume`。

- **Unix Timestamp 與 ISO Time**
  - 公開 Response 保留原始 Unix timestamp，供排序、比較與時間運算使用。
  - 每個確認為 Unix timestamp 的欄位都附帶 UTC ISO 8601 companion field，例如 `time`／`time_iso`、`from`／`from_iso`、`requested_from`／`requested_from_iso`。
  - ISO 欄位固定使用 `YYYY-MM-DDTHH:mm:ss.sssZ`；不轉換成電腦所在時區。
  - `bar_index`、`time_index`、`report_index` 等邏輯索引不是 timestamp，不附帶 ISO 欄位。
  - 市場資料 timestamp 使用 Unix seconds；串流的 `_ts` 是 Unix milliseconds，並附帶 `_ts_iso`。

- **Bars Per Request（每次歷史載入數量）**
  - `bars_per_request` 表示每次呼叫 TradingView `requestMoreData()` 時要求的舊 Bars 數量。
  - 這是請求數量，不保證 TradingView 實際回傳相同數量。
  - 不使用 Page Size，因為 TradingView Chart History 沒有 Page Number 或穩定 Page Cursor。

- **Max Requests（最大歷史載入次數）**
  - `max_requests` 表示最多允許呼叫幾次 `requestMoreData()`。
  - Response 使用 `requests_made` 記錄實際請求次數；停止原因使用 `max_requests`，不使用 Max Pages。

- **Max Bars（最大歷史資料量）**
  - `max_bars` 表示合併、依 Timestamp 去重後最多保留與輸出的 Bars 數量。
  - 這是獨立於 `max_requests` 的記憶體與輸出安全限制。

- **Bar Index（K 棒索引）**
  - 指某根 Bar 在 TradingView Chart 中的邏輯位置。
  - 可用來表示 Strategy Order 或 Pine Drawing 出現在哪一根 Bar。
  - Bar Index 可能在載入更多歷史資料後改變，因此不適合作為穩定的分頁游標。
  - Bar Index 不等同於結果集合分頁使用的 Offset。
  - Strategy Trade 中的 `bar_index` 只是 Entry／Exit 發生位置的 metadata，不能用來向 TradingView 請求下一批 Strategy Trades。

- **Visible Range（可視範圍）**
  - 指目前 Chart 畫面顯示的時間區間或 Logical Bar Range。
  - Visible Range 不代表 TradingView 已載入的完整歷史資料範圍。

## Studies and Pine Script

- **Study（研究項目）**
  - 指附加在 Chart 上的計算型資料來源。
  - Indicator 與 Strategy 都屬於 Study。

- **Indicator（指標）**
  - 指附加於 Chart、用來計算或顯示資料的非策略 Study。
  - 例如 RSI、MACD 與 Moving Average。
  - Indicator 可以是 TradingView 內建指標或 Pine Indicator。

- **Strategy（策略）**
  - 指可由 Strategy Tester 執行回測的 Pine Study。
  - 一個 Chart 可以同時存在多個 Strategy Instance。
  - 操作特定 Strategy 時應使用 Strategy Instance 的 `entity_id`，不應只依靠名稱或第一個搜尋結果。

- **Strategy Instance（策略實例）**
  - 指某個 Strategy 被加入特定 Chart 後產生的執行實例。
  - 同一份 Pine Strategy 可以被加入多次，並使用不同的 Inputs。
  - Strategy Instance 應以其 Chart Entity ID 識別。

- **Active Strategy（目前操作的策略）**
  - 指 Strategy Tester 或 API 當前準備讀取的 Strategy Instance。
  - 本 repo 透過 `strategy select`／`strategy_select` 使用明確的 Strategy Instance `entity_id` 選擇並讀回驗證。
  - Report／Orders／Trades 等 Strategy operations 應由呼叫端提供 `entity_id`，避免依賴隱式的「第一個策略」。

- **Entity ID（圖表實例 ID）**
  - 指 Indicator、Strategy 或 Drawing 加入 Chart 後的實例 ID。
  - 可用於移除 Study、修改 Inputs、選擇 Strategy 或查詢特定 Entity。
  - Strategy Instance 的主要 selector 使用 `entity_id`；若 response 使用語意化欄位 `strategy_id` 或 `strategy_entity_id`，其值仍是同一個 Entity ID，不建立另一種 ID。

- **Pine Script（Pine 原始碼）**
  - 指 Pine Editor 中的程式碼。
  - Pine Script 可以宣告為 Indicator、Strategy 或 Library。

- **Pine Editor（Pine 編輯器）**
  - 指 TradingView 底部用來編輯 Pine Script 的 Panel。
  - Pine Editor 是 UI Panel，不等同於 Pine Script 本身。

- **Saved Pine Script（已儲存 Pine 腳本）**
  - 指儲存在 TradingView 帳號中的 Pine Script。
  - 通常具有 `script_id`、名稱與版本。
  - `script_id` 不等同於 Chart 上 Strategy Instance 的 `entity_id`。

- **Pine Drawing（Pine 繪圖輸出）**
  - 指 Pine Script 產生的 Line、Label、Box 或 Table。
  - Pine Drawing 應與使用者手動加入的 Drawing 區分。

## Strategy backtesting

- **Strategy Tester（策略測試器）**
  - 指 TradingView 底部顯示策略回測結果的 Panel。
  - 包含 Overview、Performance Summary 與 List of Trades 等內容。
  - Strategy Tester 是 UI Panel，不是 Strategy 本身。

- **Strategy Report（策略回測報告）**
  - 指 Strategy 計算完成後產生的回測結果。
  - 通常包含 Performance Metrics、Strategy Trading Data，以及 TradingView runtime 可提供的其他回測資料。
  - Strategy Report 是 Strategy 回測的輸出，不是 Symbol 的 OHLCV Market History Data。

- **Performance Metrics（績效指標）**
  - 指 Net Profit、Max Drawdown、Profit Factor 與 Win Rate 等統計結果。
  - 本 repo 目前主要從 `reportData().performance` 取得。

- **Order（委託／策略事件）**
  - 指 Strategy 原始回測結果中的單一委託或成交事件。
  - 本 repo 可從 `ordersData()` 取得這類資料。
  - Entry 與 Exit 可能分別是兩筆 Order。

- **Trade（交易）**
  - 專指 Entry 與 Exit 配對後的交易紀錄。
  - 一筆 Trade 通常包含 Entry、Exit、Profit 與 Quantity 等資料。
  - `strategy_get_orders` 回傳原始 Orders；deprecated `strategy_get_trades` 回傳tail-only配對 Trades，兩者不可混稱。
  - Snapshot-complete的新介面使用`strategy_get_trading_report`、`strategy_get_trading_data`與`strategy_export_trading`；不得以legacy tools結果冒充完整匯出。

- **Strategy Trading Data（策略回測交易資料）**
  - 指 TradingView 根據 Historical Market Data、Pine Strategy、Strategy Inputs 與 Strategy Properties，透過 Broker Emulator 計算出的回測交易紀錄。
  - 資料包含策略模擬的 Entry、Exit、方向、時間、價格、數量、淨損益與其他 Trade-level metrics。
  - 本 repo 目前從指定 Strategy Instance 的 `reportData().trades` 取得 paired Strategy Trades。
  - Strategy Trading Data 是已完成 Strategy Report 的結果集合；取得下一批資料應對此集合使用 Offset／Limit 或 Cursor，不應呼叫 Chart History `requestMoreData()`。
  - Strategy Trading Data 不是 OHLCV、不是 Watchlist 行情，也不是 Broker Account 的實際成交紀錄。

- **Broker Execution / Actual Broker Trade（券商實際成交）**
  - 指送往真實 Broker Account 並實際成交的交易。
  - Strategy Tester 的 Strategy Trading Data 是 Broker Emulator 的回測結果，不代表真實下單或實際成交。
  - 文件不可只用「真實交易資料」指稱 Strategy Trading Data；應明確寫成「Strategy 實際計算出的回測交易資料」或「策略回測交易資料」。

- **Offset（資料位移）**
  - 指分頁取得 Orders 或 Trades 時，在結果集合中的起始位置。
  - 例如 `offset=100`、`limit=100` 表示從第 101 筆開始取得最多 100 筆資料。
  - Offset 不等同於 Bar Index。
  - Strategy Trade Offset 只切分同一份 Strategy Report 的 Trade results，不會載入或重新計算 Market History Bars。

- **Limit（每批數量）**
  - 指一次最多回傳多少筆結果。
  - Limit 應與 Offset 或其他明確的分頁游標搭配使用。

- **Snapshot ID（結果快照 ID）**
  - 指用來辨識同一份回測結果的 repo 分頁抽象；目前不一定已實作。
  - 多次分頁請求應使用相同 Snapshot ID，避免期間重新計算造成資料重複或遺漏。
  - 修改 Strategy Inputs、切換 Symbol、切換 Timeframe 或重新計算 Strategy 後，應產生新的 Snapshot ID。

- **Equity Curve（權益曲線）**
  - 指 Strategy 執行期間帳戶權益隨時間變化的序列。
  - Equity Curve 不等同於單筆 Trade 的 Profit。

## Panels and UI components

- **Panel（面板）**
  - 指 TradingView 中可展開或收合的功能區域。
  - 使用時應指明是哪一種 Panel，避免只說「打開面板」。

- **Bottom Panel（底部面板）**
  - 指位於 Chart 下方的功能區。
  - 常見 Bottom Panel 包含 Pine Editor 與 Strategy Tester。

- **Right Panel / Sidebar（右側面板）**
  - 指位於 TradingView 右側的功能區。
  - 常見項目包含 Watchlist、Alerts、Trading Panel 與 Object Tree。

- **Watchlist（觀察清單）**
  - 指使用者儲存的一組 Symbols。
  - Watchlist 本身具有 ID、名稱與 Symbol 清單。

- **Alert（警示）**
  - 指針對 Symbol、Indicator 或其他條件建立的 TradingView Alert。
  - Alert 不等同於 Strategy Order。

- **Trading Panel（交易面板）**
  - 指連接 Broker 或 Paper Trading 等功能的面板。
  - Trading Panel 與 Strategy Tester 是不同系統。

- **Depth of Market / DOM（市場深度）**
  - 指買賣盤與 Order Book 資料。
  - 文件應使用完整名稱 `Depth of Market (DOM)`，避免與 HTML DOM 混淆。

- **HTML DOM**
  - 指 TradingView Desktop 頁面的 HTML 元素結構。
  - `ui_*` 工具主要透過 HTML DOM 操作按鈕、輸入框與選單。
  - 不應單獨使用 `DOM` 指稱 HTML DOM。

- **Drawing（繪圖物件）**
  - 指使用者加在 Chart 上的 Trend Line、Horizontal Line、Rectangle 或 Text 等物件。
  - 每個 Drawing 通常具有 Entity ID。

- **Replay / Bar Replay（K 棒回放）**
  - 指 TradingView 的歷史行情模擬模式。
  - Replay Trade 是回放過程中的模擬手動交易，不等同於 Strategy Tester 的 Strategy Trade。

- **UI Element（UI 元件）**
  - 指可由 `ui_*` 工具操作的按鈕、輸入框、選單或頁籤。
  - UI Element 是通用 UI 操作層級，不是 TradingView 的業務資料實體。

## Repository abstractions

- **CDP Connection（CDP 連線）**
  - 指本 repo 與 TradingView Desktop 之間的 Chrome DevTools Protocol 通訊連線。
  - CDP Connection 不是 TradingView Panel 或 Chart Component。

- **MCP Tool（MCP 工具）**
  - 指 MCP Client 可以呼叫的操作，例如 `chart_get_state`。
  - MCP Tool 不是 TradingView UI Component。

- **CLI Command（CLI 指令）**
  - 指終端機使用的 `tv` 指令。
  - CLI Command 通常是 MCP Tool 或 Core Function 的命令列入口。

- **Core Function（核心函式）**
  - 指 `src/core` 中實際操作 TradingView 的 repo 內部函式。
  - MCP Tool 與 CLI Command 最後通常會呼叫 Core Function。

- **Batch（批次操作）**
  - 指本 repo 跨多個 Symbols 或 Timeframes 執行相同流程的協調抽象。
  - Batch 不是 TradingView 原生 UI Component。

## Canonical naming rules

- 使用 `tab` 表示 TradingView Desktop 最上方的分頁。
- 使用 `tab_index`／`target_id` 定位 Tab；使用 `url_chart_id` 表示 CDP target URL 中解析出的 Chart token。
- 使用 `layout_id` 表示 TradingView runtime／URL Layout ID；使用 `saved_layout_id` 表示帳號儲存層數字 ID；使用 `layout_name` 表示可讀名稱。
- 使用 `pane` 表示 Tab 內的一格圖表。
- 使用 `pane_index`／`pane_id` 定位 Pane；不建立衍生 `pane_label`。
- 使用 `chart` 表示 Pane 內的圖表元件。
- 使用 `saved_layout` 表示帳號中儲存的 Chart Layout。
- 使用 `pane_layout` 表示多圖表的格線排列。
- 使用 `script_id` 表示儲存在帳號中的 Pine Script ID。
- 使用 `entity_id` 選擇 Chart 上的 Strategy Instance；`strategy_id`／`strategy_entity_id` 若出現在 response，必須與該 `entity_id` 相同，不建立第三種 ID。
- 使用 `bar_index` 表示 K 棒在 Chart 中的邏輯位置。
- 使用 `bars_per_request`、`max_requests`、`requests_made` 與 `max_bars` 描述 Chart History 載入；不使用 Page/Page Size/Max Pages。
- 使用 `offset` 表示 Orders 或 Trades 結果集合中的分頁位置。
- 使用 `order` 表示原始委託或成交事件。
- 使用 `trade` 表示 Entry 與 Exit 配對後的交易。
- 使用 `replay_trade` 表示 Bar Replay 中的模擬交易。
- 使用 `strategy_trade` 表示 Strategy Tester 產生的回測交易。
- 使用 `strategy_trading_data` 表示 Strategy Report 中由 paired Strategy Trades 組成的回測交易資料集合；不得用它表示 OHLCV 或 Broker Account 實際成交。
- 使用 `Depth of Market (DOM)` 表示市場深度，使用 `HTML DOM` 表示頁面元素結構。
- 避免使用沒有上下文的 `layout`、`panel`、`id`、`DOM` 或 `component`。
