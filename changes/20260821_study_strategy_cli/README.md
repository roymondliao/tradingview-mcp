# Study and Strategy CLI

Status: `done`

## Objective

建立一致且可驗證的 Study／Strategy vertical slices：Account Saved Pine Scripts 使用 `pine` 與 `script_id`，Active Pane Study Instances 使用 `study` 與 `entity_id`，Strategy Tester 專屬操作使用 `strategy` 與明確的 Strategy Entity ID。

完成後，使用者可以列出 Account Saved Strategies／Indicators、辨識 Active Pane 的 Study 類型、搜尋並加入 Study、讀取及修改 Inputs、移除 Instance、選擇 Strategy，並取得指定 Strategy 的 Report、Orders、Trades 與 Equity。所有 CDP 操作都必須在有限時間內成功或回傳結構化錯誤。

## Entry criteria

- [`Study and Strategy CLI Design`](../../docs/study_strategy_cli_design.md) 是本 Feature 的產品與命名基準；Open Questions 必須在相關 Task 實作前解決並回寫。
- [`TradingView MCP Terminology Definition`](../../docs/terminology.md) 定義 `script_id`、`entity_id`、Study、Strategy、Order 與 Trade 等名詞。
- 前期人工 CLI 檢測發現的 Runtime timeout、Unsupported Commands 與無 JSON 回應案例，必須轉換為 repository 內可重複執行的 deterministic regression tests；不依賴一次性的 command output 紀錄。
- TradingView Desktop 已登入並以 CDP port `9222` 啟動；Live Smoke 不可破壞既有使用者 Scripts 或 Pane State。
- Node.js 22.x 以上與目前 repository CI commands 可正常執行。

## Shared design

共用的 resource model、vertical-slice contract、module boundary、runtime/error rules、mutation verification 與 testing model 定義於 [`LLD.md`](./LLD.md)。每個功能 Task 必須同時交付適用的 Core、CLI、MCP、Tests 與 Documentation，不得把其中一層留到 Regression Gate 補齊。

## Tasks

| ID | Task | Status | Depends on |
| --- | --- | --- | --- |
| [TASK-001](./TASK-001-cdp-runtime-reliability.md) | CDP Runtime reliability | `done` | — |
| [TASK-002](./TASK-002-study-domain-and-state.md) | Study domain model and Chart State | `done` | TASK-001 |
| [TASK-003](./TASK-003-account-pine-read.md) | Account Saved Pine read operations | `done` | TASK-001, TASK-002 |
| [TASK-004](./TASK-004-account-pine-write.md) | Account Saved Pine write operations | `done` | TASK-003 |
| [TASK-005](./TASK-005-study-catalog-search.md) | Study Catalog search | `done` | TASK-001, TASK-002 |
| [TASK-006](./TASK-006-pane-study-list-get.md) | Active Pane Study list and get | `done` | TASK-001, TASK-002 |
| [TASK-007](./TASK-007-pane-study-add.md) | Add Study to Active Pane | `done` | TASK-003, TASK-005, TASK-006 |
| [TASK-008](./TASK-008-pane-study-mutations.md) | Active Pane Study mutations | `done` | TASK-006 |
| [TASK-009](./TASK-009-strategy-selection.md) | Strategy Instance selection | `done` | TASK-006, TASK-008 |
| [TASK-010](./TASK-010-strategy-data-commands.md) | Strategy data commands | `done` | TASK-009 |
| [TASK-011](./TASK-011-regression-and-delivery-gate.md) | Regression and delivery gate | `done` | TASK-004, TASK-007, TASK-008, TASK-010 |

Dependency flow:

```text
TASK-001 CDP reliability
├── TASK-002 Study model/state
│   ├── TASK-003 Account Pine read → TASK-004 Account Pine write
│   ├── TASK-005 Study search ──────────────┐
│   └── TASK-006 Pane list/get ───────┐     │
│                                    ├── TASK-007 Pane add
│                                    └── TASK-008 Pane mutations
│                                           │
│                                           └── TASK-009 Strategy selection
│                                                    │
│                                                    └── TASK-010 Strategy data
│
TASK-004 + TASK-007 + TASK-008 + TASK-010
└── TASK-011 regression and delivery gate
```

TASK-003 與 TASK-005 可在 TASK-002 完成後平行；TASK-006 也可平行進行。TASK-004 只管理 Account-owned Scripts，TASK-007／008 只管理 Active Pane Instances。TASK-011 只整合與重跑各 Task 已建立的 Assertions，不負責補實作缺少的 Feature Behavior。

## Exit criteria

- `state.studies[]` 對每個 Active Pane Study 回傳 `entity_id`、`name`、`type` 與 `visible`。
- Account Saved Pine List／Get 能以 `script_id` 與 Type Filter 區分 Strategy、Indicator、Library 或 Unknown。
- Account-owned Script Create／Update／Delete 具有 readback verification，Delete 未確認時不會改變資料。
- Study Search 可以區分本次支援的 Built-in 與 Account Sources，Ambiguous Result 不會被默默加入；Community 明確列為 deferred scope。
- Study List／Get／Add／Inputs／Toggle／Remove 只作用於 Active Pane，並在 Mutation 後驗證結果。
- Strategy Select 可在多 Strategy Pane 中明確選擇 Instance；Report／Orders／Trades／Equity 不再隱式猜測第一個 Strategy。
- Orders 與 Trades 具有不同 contract；現有錯誤命名有明確 Compatibility Policy。
- CLI 與 MCP 對同一操作共用 Core Function、Validation、Response 與 Error Semantics。
- CDP Connect／Domain Enable／Runtime Evaluate／Chart Ready 無回應時，CLI 在設定 timeout 內輸出 JSON Error 並結束。
- Unit、CLI、Lint、Full Test Suite 與安全的 Live Smoke Validation 通過。

## Feature completion rule

只有 TASK-011 進入 `done`、所有 Dependencies 為 terminal `done`，且 `npm run lint`、`npm run test:unit`、`npm run test:cli` 與 `npm run test:all` 通過後，本 Feature 才能標記為 `done`。Live TradingView 無法在 CI 執行的案例必須由 deterministic test seam 覆蓋，並在 Completion Record 記錄實際 Live Smoke 環境與結果，不得以永久 Skip 取代核心 contract validation。

## Feature completion record

- Completed: 2026-08-22.
- Supported catalog scope: Account Saved Pine Scripts and Built-in Pine Studies. Community Search／Add is deferred to a future feature.
- Automated gate: `npm run test:all` passed `243/243`; `npm run test:cli` passed `17/17`; lint completed with zero errors and four pre-existing warnings; `git diff --check` passed.
- Live gate: TradingView Desktop 3.3.0 on Chrome 140／Electron 38.2.2; Built-in and Account add/get/input/remove cleanup passed; explicit Strategy active/report/orders/trades/equity reads passed.
- 2026-08-25 follow-up: explicit Tab/Layout/Pane selectors and non-page History naming were added; safe regression passed `250/250`, CLI passed `19/19`, and live reads distinguished `dev` from the background `Short-Strategy` Layout without `pane_label`.
- 2026-08-25 final gate: Unix timestamp ISO companion fields and their regression coverage raised the safe full suite to `256/256`; CLI remained `19/19`, lint reported zero errors and three pre-existing warnings, and `git diff --check` passed.
