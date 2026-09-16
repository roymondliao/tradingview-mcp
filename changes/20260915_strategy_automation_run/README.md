---
id: FEATURE-20260915-STRATEGY-AUTOMATION-RUN
title: Strategy Automation Run
status: in_progress
created: 2026-09-15
scope:
  - run-configuration
  - resource-resolution
  - watchlist-snapshot
  - strategy-sync
---

# Strategy Automation Run

Status: `planned`

## Objective

建立CLI-first的Strategy automation run，讓使用者以versioned config描述Pine Strategy、TradingView Chart Layout、Pane、Watchlist、Backtest設定與輸出位置，再由CLI解析實際TradingView resources並重用既有Strategy Trading Core完成後續流程。

需求與LLD討論已完成，implementation依[`LLD.md`](./LLD.md)與下列Tasks執行。每個Task完成時必須更新status、validation evidence與completion record，不得只修改程式碼。

## Discussion sequence

1. Run Configuration與資源解析。
2. 完整Watchlist Snapshot。
3. Strategy Sync與Update。

Durable Export／Retry／Resume與Local-only E2E會在上述三項contract確定後另外確認依賴與task邊界；Desktop version compatibility由`changes/20260903_desktop_version_compatibility`負責。

## Confirmed decisions

### Run Configuration與資源解析

詳細contract見[`RUN_CONFIGURATION.md`](./RUN_CONFIGURATION.md)。目前已確認：

- 入口為`strategy run --config <path>`與read-only的`--dry-run`。
- `run_id`選填；省略時由CLI建立可讀、可排序且避免碰撞的ID。
- User以TradingView畫面可見的exact name設定Layout、Saved Strategy與Watchlist，不需取得或維護TradingView internal IDs。
- `pane_index`仍為必要的0-based selector，因為Pane沒有可靠名稱。
- CLI在dry-run解析並驗證name是否存在、是否重複以及整份config是否有效。
- CLI將完整resolved IDs寫入immutable `run.json`，供執行、審計與未來resume使用。
- 正式run必須重新執行相同驗證，不能假設先前dry-run後Desktop狀態沒有改變。

### 完整Watchlist Snapshot

詳細contract與live evidence見[`WATCHLIST_SNAPSHOT.md`](./WATCHLIST_SNAPSHOT.md)。目前已確認：

- 新增`watchlist snapshot --name <name>`作為完整、穩定且可驗證的named Watchlist讀取入口。
- 既有`watchlist list`保留為Account inventory；`watchlist get`明確維持Active Watchlist DOM／quote view，不保證完整。
- Snapshot使用exact name解析唯一`watchlist_id`，不切換Active Watchlist。
- 完整Symbols由Account detail source讀取；DOM rows不可作為完整Snapshot來源，也不實作UI scrolling fallback。
- Snapshot以連續兩次count、modified與ordered-symbol fingerprint讀取證明穩定性。
- `stock_list` live test已驗證declared 448、Account detail 448、React runtime 448、unique 448、invalid 0、duplicate 0，兩次ordered fingerprint一致；同時DOM僅回傳37筆。

### Base Strategy與Parameter Sets

詳細contract與live evidence見[`STRATEGY_PARAMETER_SETS.md`](./STRATEGY_PARAMETER_SETS.md)。目前已確認：

- Strategy source sync與Parameter Set execution是不同階段；只修改Study inputs不建立新的Saved Script version。
- 一個Parameter Set batch固定`script_id`、script version、source hash與Pane `entity_id`，以不同`inputs_fingerprint`識別各組參數。
- Parameter Sets屬於高階`strategy run` config，不屬於Strategy Sync service。
- Config以exact Pine input title設定參數；Study Core解析成TradingView internal input ID。
- `study inputs get`必須將`getInputsInfo()` metadata與`getInputValues()` current values依ID合併。
- `study inputs set`支援互斥的`--inputs`與`--inputs-by-name`，且採all-or-nothing validation，不允許partial mutation。
- Study module只處理Input inventory、validation、mutation與readback；等待Strategy重新計算並匯出Report／Trading Data由`strategy run`負責。

### Pine Source Auto Sync

Strategy source synchronization的已確認部分見[`STRATEGY_SYNC_UPDATE.md`](./STRATEGY_SYNC_UPDATE.md)：

- Config中的local Pine file是本次automation run的source of truth。
- `strategy run --dry-run`以source hash判斷並顯示Account Saved Strategy預計執行`create`、`update`或`reuse`，不得mutation。
- 正式`strategy run`在Parameter Sets前自動完成server compile、Account create／update、source／version readback與Pane refresh。
- Input mutation不執行`pine update`，不建立新的Saved Script version。
- Source hash前先將CRLF／CR正規化為LF，避免純換行差異誤建新version。
- Pane refresh採add latest → 驗證新版與Inputs／Report → remove old；Account update後舊Instance已實證仍載入舊version，新Instance使用相同`script_id`、latest version與新的`entity_id`。

### Candidate Pine Input Schema

Local source與舊Parameter Sets的dry-run validation contract見[`PINE_INPUT_SCHEMA.md`](./PINE_INPUT_SCHEMA.md)：

- TradingView compiler response可識別Input variable name與inferred type，但不提供title、default、group或constraints。
- `pine check`應保留sanitized `input_variables`；`data/obv-v3.pine`已live驗證compile成功並取得16個Input variables。
- Minimal Local Scanner只定位compiler已確認的variables，解析static title、default與constraints；不建立完整Pine Parser。
- Candidate Schema用於update前驗證全部Parameter Sets；update後再以新版Pane `getInputsInfo()`作authoritative readback。
- Config引用removed／renamed／ambiguous Input或不合法value時，dry-run必須blocking error，不能先update Account。

## Open discussions

- 無blocking design discussion；實作中若live runtime evidence與contract衝突，必須先更新對應spec／LLD，不可用猜測fallback。

## Tasks

| ID | Task | Status | Depends on |
| --- | --- | --- | --- |
| [TASK-001](./TASK-001-candidate-pine-input-schema.md) | Candidate Pine Input Schema | `done` | — |
| [TASK-002](./TASK-002-study-input-catalog-name-mutation.md) | Study Input Catalog and Name Mutation | `done` | — |
| [TASK-003](./TASK-003-named-watchlist-snapshot.md) | Complete Named Watchlist Snapshot | `done` | — |
| [TASK-004](./TASK-004-run-config-resolution-dry-run.md) | Run Config, Resource Resolution, and Dry-run | `done` | TASK-001～003 |
| [TASK-005](./TASK-005-strategy-account-pane-sync.md) | Strategy Account Sync and Safe Pane Refresh | `todo` | TASK-001, 002, 004 |
| [TASK-006](./TASK-006-parameter-set-execution.md) | Parameter Set Planning and Execution | `todo` | TASK-002, 004, 005 |
| [TASK-007](./TASK-007-strategy-run-export-integration.md) | Strategy Run Export Integration | `todo` | TASK-003～006 |
| [TASK-008](./TASK-008-regression-live-delivery-gate.md) | Regression, Live Validation, and Delivery Gate | `todo` | TASK-001～007 |

Recommended implementation order：

```text
TASK-001 Candidate Schema ─┐
TASK-002 Study Inputs ─────┼─> TASK-004 Dry-run ─> TASK-005 Strategy Sync
TASK-003 Watchlist Snapshot┘                         │
                                                    ▼
                                      TASK-006 Parameter Sets
                                                    │
                                                    ▼
                                      TASK-007 Strategy Run
                                                    │
                                                    ▼
                                      TASK-008 Delivery Gate
```

TASK-001～003沒有code dependency，可分開實作；同一working tree仍需避免重疊編輯Core exports、package test lists與shared docs。

## Exit criteria

- Name-only Run Config可在dry-run解析成完整TradingView identities，所有read-only可偵測錯誤在mutation前呈現。
- Candidate Pine Input Schema與new Pane Runtime Schema可以驗證Parameter Sets。
- `study inputs get/set`具name metadata、strict ID／name mutation與完整readback。
- Named Watchlist Snapshot能證明完整、ordered、stable，且不依賴DOM scrolling。
- Changed local Pine source可自動更新Account並安全refresh Pane；same source不新增version。
- 多組Parameter Sets不互相繼承state，Report fresh後才export，結束時恢復Base Inputs。
- `strategy run --config`產生canonical artifacts並維持既有Trading Report／Data snapshot與reconciliation guarantees。
- Deterministic regression與bounded live validation通過；未實作的retry／resume不出現在成功capability contract。
