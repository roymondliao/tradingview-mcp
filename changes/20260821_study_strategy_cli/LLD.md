# Study and Strategy CLI LLD

## Purpose and scope

本文件定義 Study／Strategy Feature Tasks 共用的 implementation contract。長期術語與預期 CLI surface 以 `docs/terminology.md` 及 `docs/study_strategy_cli_design.md` 為 source of truth；本 LLD 規範各 Task 如何交付完整 vertical slice、共享 resource model，並避免 Account Script 與 Pane Instance 的隱性耦合。

## Resource model

```text
Account-owned Saved Pine Script        Searchable Study Definition
script_id                              built-in / account
          └──────────────┬──────────────┘
                         │ add to Active Pane
                         ▼
                   Study Instance
                   entity_id
                   type: strategy | indicator | unknown
                         │ strategy only
                         ▼
              Strategy Tester report data
```

- `script_id` 只能識別 Account Saved Pine Script。
- `entity_id` 識別特定 Active Pane 的 Study Instance。
- `strategy_id` 是 Strategy Instance Entity ID 的語意化 response field，不建立第三種 ID。
- Built-in Definition 不是 Account-owned Script，不可使用 Account Delete。Community Definition 保留為後續擴充，且同樣不得使用 Account Delete。
- Type Metadata 不足時使用 `unknown`，不可默認為 Indicator。

## Vertical-slice completion contract

除 TASK-001 Foundation 與 TASK-011 Gate 外，每個功能 Task 在適用範圍內必須包含：

```text
CLI command and argument validation
→ MCP tool schema
→ shared Core function and domain validation
→ CDP page adapter / TradingView API interaction
→ mutation readback when applicable
→ normalized response and error contract
→ unit and CLI contract tests
→ command reference and compatibility note
```

不得只新增 CLI Router 而沒有 Core／Tests，也不得只新增 Core Function 並將 CLI／MCP 留到 TASK-011。共用 Helper 在第一個真實 Consumer Task 建立；後續 Tasks 重用並補 generic tests。

## Shared module boundaries

- `src/connection.js`：Target discovery、CDP lifecycle、timeouts 與 page evaluation primitives；不包含 Study business classification。
- `src/core/pine.js`：Account Saved Pine Script read/write lifecycle，使用 `script_id`。
- `src/core/indicators.js`：既有相容層；新共用 Study Instance logic 應逐步移至或由 `src/core/studies.js` 統一提供。
- `src/core/studies.js`：Study classification、Catalog search、Active Pane List/Get/Add/Inputs/Visibility/Remove。
- `src/core/data.js`：市場資料與 Strategy Report data adapter；Strategy selection logic 應抽離成可指定 Entity 的共用 helper。
- `src/cli/commands/`：CLI parsing、help 與輸出入口；不保存 TradingView business logic。
- `src/tools/`：MCP schemas 與 error formatting；與 CLI 呼叫相同 Core Functions。
- `tests/`：CDP seams、Core behavior、CLI contracts、compatibility 與 opt-in Live E2E。

實作時若決定不新增 `src/core/studies.js`，必須在 TASK-002 Design／Completion Record 說明替代 module boundary，且不可讓 classification 分散複製於 `chart.js`、`data.js` 與 `indicators.js`。

## Shared runtime rules

1. Active Pane 操作前必須先解析 Desktop Active Tab 的 Chart Target；不得使用 `/json/list` 第一筆作為 Active 的假設。
2. HTTP Target Discovery、WebSocket Connect、Domain Enable、Runtime Evaluate、Promise Await 與 Chart Ready 各自具有有限 timeout 與可辨識的 error stage。
3. 每個 CLI invocation 成功或失敗都必須輸出一個 JSON result 並結束；不得只印 npm banner 後永久等待。
4. Page expression 不直接插入未處理 input；字串使用既有 `safeString` 或 CDP `CallArgument`。
5. Account read/write 只在已登入 TradingView page context 使用 authenticated request；不得把 credentials 或完整 private source 寫入 logs。
6. Active Pane Mutations 使用操作前 snapshot、執行 mutation、readback verification。沒有 readback confirmation 不可回傳 `success: true`。
7. Strategy Inputs 或 Visibility 改變可能觸發 Report recomputation；Strategy command 必須區分 `pending`、`ready` 與 `timeout`。

## Command ownership

- `pine`
  - Account Saved Pine Script List／Get／Create／Update／Delete。
  - 主要 ID 為 `script_id`。
- `study`
  - Study Catalog Search 與 Active Pane Study Instance lifecycle。
  - 主要 ID 為 `entity_id`。
- `strategy`
  - Active Strategy Selection、Report、Orders、Trades 與 Equity。
  - 主要 ID 為 Strategy Instance `entity_id`。
- `indicator`
  - 遷移期間保留的 Compatibility Alias；不得發展另一套不同 Core Contract。

## Response and error contract

- Success response 至少包含 `success: true` 與 command-specific payload。
- Error response 至少包含 `success: false`、stable error `code` 與 safe `message`。
- CDP errors 額外包含可公開的 `stage`、`timeout_ms`、`target_id` 或 `chart_id`。
- Validation errors 必須區分 Missing ID、Wrong ID Kind、Unknown Entity、Wrong Study Type 與 Ambiguous Search Result。
- TradingView private source、cookies、credentials、raw encrypted Inputs 與 unrestricted raw page objects 不得出現在 response。
- CLI 與 MCP 對相同 Core error 使用相同 code；Transport-specific formatting 不得改變語意。

## Mutation and destructive-operation rules

- `pine delete` 只能刪除經 Account List/Get 驗證為 owned 的 Script，且需要互動確認或 `--yes`。
- `study remove` 只移除 Active Pane Entity，不刪除 Account Script。
- `study inputs set` 先保存目前 Inputs，更新後讀回已套用 keys；Unknown Keys 不可靜默成功。
- `study add` 比較 mutation 前後 Entity IDs，並驗證新增 Instance 的 Name、Type 與 Active Pane ownership。
- Live Tests 只能刪除本次 Test 建立且 ID 已驗證的 disposable resource；不得使用既有使用者 Script 或 Study 作為 destructive fixture。

## Testing model

每個 Task 的驗證分為：

- Unit：Target selection、timeout、type classifier、ID validation、response normalization、input filtering 與 error mapping。
- CLI contract：command routing、options、exit codes、JSON stdout/stderr 與 legacy alias behavior。
- Core integration with deterministic seams：模擬 TradingView page API、Account Facade、multi-pane／multi-strategy state 與 mutation readback。
- Live smoke：在已登入的 TradingView Desktop 驗證最小代表性流程；write/delete 僅使用本次建立的 disposable resource。

CI 不要求真實 TradingView Account，但不得因此省略 deterministic integration coverage。Live-only limitation 必須記錄，不能用假成功 response 取代。

## Dependency rationale

- TASK-001 先建立所有功能共用的 Runtime timeout 與 Active Target guarantee。
- TASK-002 集中 Study Type 與 Instance response，避免 Pine、State、Study 與 Strategy 各自分類。
- TASK-003 與 TASK-005 在 TASK-002 後可平行，分別建立 Account read 與 Catalog search。
- TASK-006 同期建立 Pane read slice；TASK-007／008 只在可靠 List/Get 後進行 Mutation。
- TASK-004 在 Account read 可以證明 ownership 後才允許 destructive Script operations。
- TASK-009 等待 Pane read 與 visibility/input behavior，才能安全選擇並等待 Strategy。
- TASK-010 只在 Strategy Selection 可驗證後重構 Report Data，避免延續 `findStrategy()` 隱式選擇。
- TASK-011 只執行 compatibility audit、regression、live smoke 與 completion documentation，不新增功能。

## Delivery boundaries

每個 Task 建議維持一個主要 feature commit。Task 進入 `done` 前必須更新 YAML status、README Task Table、Validation Result 與 Deliverables；若 Live Smoke 受外部環境阻擋，必須保留 deterministic test evidence 並記錄 blocker，不得降低 Acceptance Criteria。
