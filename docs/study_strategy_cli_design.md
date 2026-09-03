# Study and Strategy CLI Design

> Status: Implemented (Account + Built-in scope)
>
> Community Script Search／Add 保留為後續擴充需求，不屬於本次完成門檻。

## Goals

- `state` 能辨識 Active Pane 中的 Study 是 Strategy、Indicator 或 Unknown。
- 統一 Strategy 與 Indicator 共用的 Pane 操作。
- 區分 Account Level 的 Saved Pine Script 與 Active Pane Level 的 Study Instance。
- 使用明確的 ID，避免混用 `script_id` 與 `entity_id`。
- 將 Strategy 專屬的回測功能與通用 Study 管理功能分開。

## Resource model

```text
Saved Pine Script / Study Definition
  script_id
        │ add to pane
        ▼
Study Instance
  entity_id
  type: strategy | indicator | unknown
```

- **Saved Pine Script**
  - 儲存在 TradingView Account 下。
  - 使用 `script_id` 識別。
  - 類型可以是 `strategy`、`indicator` 或 `library`。

- **Study Definition**
  - 表示可以搜尋或加入 Chart 的 Study 定義。
  - 本次支援 Saved Pine Script 與 Built-in；Community Script 為後續擴充。
  - 並非所有 Study Definition 都屬於目前 Account。

- **Study Instance**
  - 表示已經加入特定 Pane 的 Study 實例。
  - 使用 `entity_id` 識別。
  - 類型可以是 `strategy`、`indicator` 或 `unknown`。

## ID rules

- `script_id`
  - 識別 Account 下儲存的 Pine Script。
  - 用於 Saved Pine Script 的 Get、Update、Delete 與 Add to Pane。

- `entity_id`
  - 識別特定 Pane 上的 Study Instance。
  - 用於讀取 Inputs、修改 Inputs、切換可見性、移除 Instance，以及選擇 Strategy。

- `strategy_id`
  - 對外表示 Strategy Instance 時使用的語意化欄位名稱。
  - 其值是該 Strategy Instance 的 `entity_id`。

## Chart state

`state` 應回傳 Active Pane 中所有 Study Instances，並標示類型。

Pane-scoped commands 可以透過明確的 Tab／Layout／Pane selector 避免依賴 UI focus：

```bash
npm run tv -- tab list
npm run tv -- state --layout-id aQoXnpKX --pane-index 0
npm run tv -- state --saved-layout-id 201414175 --pane-index 0
npm run tv -- study list --tab-index 0 --pane-index 0
npm run tv -- study list --url-chart-id aQoXnpKX --pane-index 0
```

- `tab_index`：`tab list` 回傳的 Desktop Tab index。
- `url_chart_id`：從 Tab URL `/chart/<token>/` 解析出的 Chart token。
- `layout_id`：Desktop runtime／URL Layout ID；Desktop 3.4.0 由 `_saveChartService.layoutId()` 取得。
- `saved_layout_id`：帳號 Saved Layout storage ID；由 Saved Layout catalog 的 `url` 映射至 `id`。
- `layout_name`：Saved Layout 的可讀名稱。
- `pane_index`／`pane_id`：選定 Layout 內的 Pane 位置與內部 ID。
- 不定義 `pane_label`；Pane 直接回傳 Symbol、Resolution 與 Active State。
- Selector 無法唯一解析時必須失敗，不可回退到第一個 Tab 或 Pane。

```bash
npm run tv -- state
```

建議回傳：

```json
{
  "success": true,
  "symbol": "NASDAQ:AAPL",
  "resolution": "1D",
  "studies": [
    {
      "entity_id": "abc123",
      "name": "My Strategy",
      "type": "strategy",
      "visible": true,
      "report_ready": true
    },
    {
      "entity_id": "def456",
      "name": "Moving Average",
      "type": "indicator",
      "visible": true
    }
  ]
}
```

- `type` 應允許：
  - `strategy`
  - `indicator`
  - `unknown`
- Metadata 不足時應回傳 `unknown`，不可直接假設為 Indicator。
- 如果可以穩定取得來源資訊，可以額外回傳 `source`、`script_id` 與 `version`。
- `state` 應維持摘要用途；完整 Inputs 應由獨立的 Get 操作取得。

## Account-level Saved Pine Scripts

Account Level 操作的是 Saved Pine Scripts，不是 Pane 上的 Study Instances。

建議由 `pine` component 負責：

```bash
npm run tv -- pine list --type strategy
npm run tv -- pine list --type indicator
npm run tv -- pine get --script-id <script_id>
npm run tv -- pine create --type strategy
npm run tv -- pine update --script-id <script_id>
npm run tv -- pine delete --script-id <script_id>
```

### List

- 列出目前 Account 擁有的 Saved Pine Scripts。
- 可以使用 `--type strategy|indicator|library` 過濾。
- 不應宣稱能列出 TradingView 所有 Built-in 或 Community Studies。

建議回傳：

```json
{
  "scripts": [
    {
      "script_id": "USER;abc123",
      "name": "My Strategy",
      "type": "strategy",
      "version": 5,
      "modified": 1780000000,
      "modified_iso": "2026-05-28T20:26:40.000Z"
    }
  ]
}
```

### Create

- Account Level 建立 Saved Pine Script 應使用 `create`。
- `add` 保留給 Add to Pane，避免同一動詞具有兩種不同生命週期含義。

### Get and Update

- 使用 `script_id` 取得或更新 Saved Pine Script。
- Update 可能包含名稱、Source 或其他 Account Script metadata，實際支援範圍需在實作前確認。

### Delete

- 只能刪除目前 Account 擁有的 Saved Pine Script。
- Built-in 或 Community Study Definition 不可透過 Account Delete 刪除。
- Delete 是破壞性操作，CLI 應要求明確確認或 `--yes`。

## Study catalog and search

Saved Pine Scripts 不等於所有可加入 Pane 的 Studies。本次 Catalog 支援 Account Saved Pine Scripts 與 Built-in Pine Studies；Community Scripts 保留為後續擴充。

建議提供：

```bash
npm run tv -- study search "Supertrend"
npm run tv -- study search "Supertrend" --source built-in
npm run tv -- study search "Supertrend" --source account
npm run tv -- study search "Supertrend" --type strategy
```

- Search 結果應包含足以供 `study add` 使用的識別資訊。
- `source` 建議允許：
  - `built-in`
  - `account`
- `type` 建議允許：
  - `strategy`
  - `indicator`
  - `unknown`

### Deferred: Community Scripts

- Community Search／Add 不屬於本次 feature scope。
- 未來實作應取得穩定 `PUB;...` identifier，避免依賴未渲染的 Indicators Dialog virtualized rows。
- 在穩定 adapter 完成前，不宣稱 `study search` 能列出或加入 Community Scripts。

## Active Pane Study Instances

Active Pane Level 操作的是已加入 Pane 的 Study Instances。

建議由 `study` component 負責：

```bash
npm run tv -- study list
npm run tv -- study list --type strategy
npm run tv -- study list --type indicator
npm run tv -- study add --script-id <script_id>
npm run tv -- study add --study-id <study_id>
npm run tv -- study add --query "Supertrend Strategy"
npm run tv -- study get <entity_id>
npm run tv -- study inputs get <entity_id>
npm run tv -- study inputs set <entity_id> --inputs '<json>'
npm run tv -- study toggle <entity_id> --visible
npm run tv -- study remove <entity_id>
```

### List

- 列出 Active Pane 上所有 Study Instances。
- 可使用 `--type strategy|indicator` 過濾。
- 每筆至少應包含：
  - `entity_id`
  - `name`
  - `type`
  - `visible`
- Strategy 可以額外包含：
  - `report_ready`
  - `is_active_strategy`

### Add

- 將 Study Definition 加入 Active Pane。
- Saved Pine Script 使用 `--script-id`。
- Built-in Study 可以使用穩定的 `--study-id`。
- Search-based Add 可以使用 `--query`，但應回傳實際匹配的項目。
- 成功後必須回傳新增 Instance 的 `entity_id` 與辨識後的 `type`。

### Get

- 使用 `entity_id` 取得 Active Pane 上特定 Study Instance 的資訊。
- 建議包含：
  - `entity_id`
  - `name`
  - `type`
  - `visible`
  - `inputs`
  - `source`
  - `script_id`（若可取得）
  - `report_ready`（Strategy only）

### Inputs

- Strategy 與 Indicator 都透過 Study Instance Inputs 調整參數。
- 修改 Inputs 不應改動 Pine Source。
- 修改後應讀回 Inputs，確認實際套用的值。
- Strategy Inputs 更新後，應等待回測重新計算完成。

### Toggle

- 顯示或隱藏特定 Study Instance。
- Strategy 隱藏後可能不會產生 Strategy Report，回傳結果應提醒呼叫端。

### Remove

- 從 Active Pane 移除指定 Study Instance。
- Remove 不會刪除 Account Saved Pine Script。
- 移除前應確認 `entity_id` 存在於 Active Pane。
- 移除後應重新查詢並確認該 Instance 已不存在。

## Strategy-specific operations

Strategy Report、Orders、Trades 與 Equity 並不是所有 Studies 都具備的能力，因此保留在 `strategy` component。

```bash
npm run tv -- strategy select <entity_id>
npm run tv -- strategy report <entity_id>
npm run tv -- strategy orders <entity_id>
npm run tv -- strategy trades <entity_id>
npm run tv -- strategy equity <entity_id>
```

- `select`
  - 將指定 Strategy Instance 設為 Strategy Tester 的 Active Strategy。
  - 應確認 `entity_id` 屬於 Active Pane 且 `type` 為 `strategy`。

- `report`
  - 取得指定 Strategy Instance 的 Performance Metrics。

- `orders`
  - 取得 Strategy 的原始 Orders。

- `trades`
  - 取得 Entry／Exit 配對後的 Trades。

- `equity`
  - 取得 Strategy Equity Curve。

## Proposed command ownership

- `pine`
  - 管理 Account Saved Pine Scripts。
  - 使用 `script_id`。

- `study`
  - 搜尋 Study Definitions。
  - 管理 Active Pane Study Instances。
  - 使用 `entity_id`。
  - 共用於 Strategy 與 Indicator。

- `strategy`
  - 管理 Strategy Tester 選擇與 Strategy 專屬回測資料。
  - 使用 Strategy Instance 的 `entity_id`。

## Proposed implementation order

1. 修正 CDP Runtime timeout，並可靠定位目前 Active Tab 的 Chart Target。
2. 擴充 `state.studies[]`，加入 `entity_id`、`type` 與 `visible`。
3. 擴充 Account Saved Pine Script List，加入 Type 辨識與過濾。
4. 實作 Active Pane `study list`。
5. 實作 `study search` 與 `study add`。
6. 重用既有 Indicator Core 實作 `study get`、`study inputs`、`study toggle` 與 `study remove`。
7. 實作 Strategy Select。
8. 串接 Strategy Report、Orders、Trades 與 Equity。

## Open questions

- CLI 最終名稱是否使用 `study`，或改用 `technical`、`analysis` 等其他名稱？
- Account List 是否只包含 Saved Pine Scripts，還需要包含 Favorites？
- Community Study Definition 是否能取得穩定且可重用的 `PUB;...` ID？（Deferred）
- `study add --query` 遇到多筆相同名稱時，應直接失敗或要求 `--source`／ID？
- `state` 是否需要包含 `script_id`，以及不同來源是否都能穩定取得？
- Account Delete 應採互動確認、`--yes`，或兩者都支援？
- Strategy Inputs 更新後，如何可靠判斷回測重新計算完成？
