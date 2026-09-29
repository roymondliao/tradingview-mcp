---
id: FEATURE-20260926-STRATEGY-DURABLE-EXPORT-RECOVERY
title: Strategy Durable Export Recovery
status: planned
created: 2026-09-26
depends_on:
  - FEATURE-20260915-STRATEGY-AUTOMATION-RUN
scope:
  - durable-artifacts
  - retry-and-backoff
  - resume-and-crash-recovery
  - cross-process-pane-ownership
---

# Strategy Durable Export Recovery

Status: `planned`

## Objective

讓現有 `strategy run --config` 在大型 Named Watchlist 與多組 Parameter Sets 的長時間執行中，將每個 Experiment／Symbol 的執行狀態與成功 artifacts 即時保存到正式 Run Directory。當單一 Symbol 發生暫時性錯誤時，系統會以固定、有限的 retry policy 重試；當 CLI process、TradingView Desktop 或機器中斷後，User 可透過獨立的 `strategy resume` command，沿用原本的 `run_id`，只執行尚未成功的 Symbols。

本 Change 延續 [`20260915_strategy_automation_run`](../20260915_strategy_automation_run/README.md) 已完成的 Run Config、Strategy Sync、Parameter Sets、Named Watchlist Snapshot、Trading Report／Data normalization 與 reconciliation，不重新設計已足夠的 artifact structure。

Implementation architecture與module-level contract見[`LLD.md`](./LLD.md)；decision rationale見[`DECISIONS.md`](./DECISIONS.md)。

## Confirmed design baseline

### Existing artifact structure remains

不新增 `plan.json`、`progress.jsonl`、`checkpoint.json` 或 per-Symbol `result.json`。Durable Recovery 沿用現有結構：

```text
<output>/<run-id>/
├── run.json
├── watchlist.json
└── experiments/<parameter-set>/
    ├── experiment.json
    ├── manifest.json
    └── symbols/<safe-symbol>/
        ├── report.json
        ├── trades.json | trades.jsonl | trades.csv
        └── reconciliation.json
```

- `run.json` 是 Run-level status 的來源。
- 每個 Experiment 的 `manifest.json` 是該 Experiment／Symbols 執行狀態的 authoritative source。
- Symbol folder 是否存在，不可用來判斷該 Symbol 是否成功。
- Dry-run 維持 read-only，不建立任何 Run artifacts。
- Formal Run artifacts升級為schema version 2；Run Config仍維持schema version 1。
- Existing `strategy trading-export` artifacts保留V1 behavior，不在本Change加入Resume。

### Direct durable Run Directory

Read-only preflight 全部通過後，`strategy run` 會以 exclusive create 建立正式 `<output>/<run-id>`，並直接在此目錄保存 durable state，不再先寫入隨機的 run-level staging directory。

因此 Run Directory 存在只表示 Run 已建立，不代表 Run 已完成。Existing `strategy run` 遇到相同 `run_id` 時仍回傳 `RUN_OUTPUT_EXISTS`；只有明確的 `strategy resume` 可以開啟既有、可恢復的 Run。

### Minimal status model

Run 與 Experiment 只使用：

- `running`
- `succeeded`
- `failed`

Run 開始落地時就是 `running`。所有工作成功才轉為 `succeeded`；可被捕捉且未恢復的 terminal error 轉為 `failed`。Abrupt process crash 無法執行 terminal update，因此 `run.json` 會保留 `running`，由後續 `strategy resume` 處理。

Symbol 使用：

- implicit `pending`：存在於 frozen Watchlist，但尚未出現在 `manifest.json.symbols[]`
- `running`
- `retry_wait`
- `succeeded`
- `failed`
- `skipped`

`failed` 表示該 Symbol 已執行但沒有成功；`skipped` 表示因 Run／Experiment-level abort 尚未執行完成。Resume 只跳過 `succeeded`，其餘狀態都屬於未完成工作。

### Per-Symbol atomic artifacts

每次 Symbol attempt 使用 Experiment 內的 attempt-owned sibling staging directory：

```text
experiments/baseline/symbols/
├── .TWSE_u3A_2330.attempt-2.staging/
└── TWSE_u3A_2330/
```

成功順序固定為：

```text
Report A
  → all Trading Data
  → Report B
  → reconciliation
  → write/close attempt staging artifacts
  → atomic rename to final Symbol directory
  → success callback atomically updates manifest.json to succeeded
```

若 process 在 rename 後、manifest callback 前 crash，manifest 仍不是 `succeeded`。Resume 必須將該 folder 視為未 committed attempt，先進行 ownership-bounded cleanup／isolation，再重新執行該 Symbol；不得因 folder 存在而直接跳過。反之，manifest 已記錄 `succeeded` 但 artifacts 缺漏或不一致時，視為 durable artifact corruption 並拒絕靜默重跑。

### Manifest updates

每個 Symbol state transition 都透過 callback 更新該 Experiment 的 `manifest.json`，並以 same-filesystem temporary file + atomic replace 落地。Manifest 保留既有 `requested_symbols`、`symbols[]`、summary、errors 與 artifact paths，不再建立第二套 progress source。

Symbol metadata 使用累積的 `attempt_count`，錯誤欄位命名為 `error`，最小內容為：

```json
{
  "code": "SYMBOL_SWITCH_FAILED",
  "phase": "symbol_switch",
  "message": "..."
}
```

不保存 `retry_exhausted` 或 `retryable`。Retry 判斷必須由 codebase 內部的 stable error classifier 做出，不可依賴 artifact metadata 的 boolean。

Run／Experiment 保留既有 `started_at`／`started_at_iso`，並以 `updated_at`／`updated_at_iso` 表示最近一次 durable state update；不新增 `completed_at`、`resume_count` 或 `last_resumed_at`。

### Fixed retry policy

Retry policy 固定在 codebase constants，不加入 Run Config，也不提供 CLI override：

```text
STRATEGY_SYMBOL_MAX_ATTEMPTS = 3
STRATEGY_SYMBOL_RETRY_DELAYS_MS = [1000, 2000]
```

每次 `strategy run` 或 `strategy resume` invocation 對一個未成功 Symbol 都有一份新的 3-attempt budget：1 次 initial attempt + 最多 2 次 retries。`attempt_count` 跨 invocations 累積，但本次 invocation 的剩餘 budget 在 memory 中計算。

Run 與 Resume 共用同一個 Symbol retry executor。若 retry 持續失敗，問題很可能來自 TradingView 或 runtime environment，因此不允許 User 無限制調大 retry 次數。

### Explicit Resume workflow

Resume 是獨立 Core module 與 CLI，不由 `strategy run` 自動偵測：

```bash
npm run tv -- strategy resume --run-directory <output>/<run-id>
```

Resume：

1. 讀取既有 `run.json`、`watchlist.json`、Experiment metadata 與 manifests。
2. 不產生新 `run_id`、新 output directory 或 derived run。
3. `succeeded` Experiment 全部跳過。
4. `running`／`failed` Experiment 只執行 manifest 中不是 `succeeded` 的 Symbols。
5. 尚未建立 manifest 的 Experiment，使用 frozen Watchlist 執行完整 Experiment。
6. 每個待處理 Symbol 取得新的固定 retry budget，並共用 Run 的 retry executor。
7. 維持原 Run 的 config、Strategy source、Watchlist Snapshot 與 Parameter Set identity。

取得 process ownership 且通過 Resume validation 後，Resume 會把原 Run 與即將繼續的 Experiment 更新為 `running`，並更新 `updated_at`；完成後再依結果轉為 `succeeded` 或 `failed`，不增加 Resume 專屬 lifecycle status。

Resume eligibility 由 durable metadata 與目前 TradingView context 的 stable identity 驗證；不能用 Symbol folder presence 推測進度。

## Resume error taxonomy

Resume 專屬的 precondition／artifact errors：

| Code | Meaning |
| --- | --- |
| `RUN_RESUME_NOT_FOUND` | Run Directory 或必要的 `run.json` 不存在。 |
| `RUN_ALREADY_SUCCEEDED` | Run 已成功完成，沒有可 Resume 的工作。 |
| `RUN_ALREADY_ACTIVE` | 另一個 live process 正在持有此 Run／Pane。 |
| `RUN_RESUME_VERSION_UNSUPPORTED` | Artifact schema 太舊、未知或不支援 Resume。 |
| `RUN_RESUME_ARTIFACT_INVALID` | 必要 local artifacts 缺漏、格式錯誤或互相矛盾。 |
| `RUN_RESUME_IDENTITY_MISMATCH` | 目前 TradingView stable identity 與原 Run 不一致。 |

Execution／restore 階段不建立重複 error code，沿用既有 `PANE_CONTEXT_CHANGED`、`STRATEGY_INPUTS_CHANGED`、`PARAMETER_SET_RESTORE_FAILED`、`CHART_RESTORE_FAILED`、`CDP_*` 與 `STRATEGY_REPORT_UNAVAILABLE` 等 codes。

## Safety properties

- 不得拼接不同 attempt、snapshot、Strategy revision、Inputs fingerprint 或 Watchlist Snapshot 的 Trading Data。
- 每個 retry attempt 都從 fresh Report A 與 Trading Data offset 0 開始。
- Resume 不覆寫或重跑 manifest 已確認為 `succeeded` 的 Symbol。
- Manifest 說明 `succeeded` 但 artifacts 不完整時，必須回報 corruption，不得以重新執行掩蓋問題。
- Existing `strategy run` collision protection 保持不變。
- Retry／Resume 不得降低 source、version、entity、Pane、timeframe、Inputs ownership 與 reconciliation guards。
- Cleanup 只能操作本 Run、Experiment、Symbol attempt 或 lock 可證明 ownership 的資源。
- Stdout／MCP response 保持 bounded，不輸出完整 Symbols、Trades 或 unbounded event history。

## In scope

- Versioned durable Run／Experiment／Symbol artifact contract。
- Direct canonical Run Directory 與 atomic `run.json`／`manifest.json` updates。
- Per-Symbol attempt-owned staging、atomic publish 與 crash-window recovery。
- Fixed retry constants、stable retry classifier、cancelable backoff 與共用 retry executor。
- 獨立 `strategy resume` Core module／CLI 與 strict identity validation。
- SIGINT／SIGTERM graceful restore，以及 abrupt crash 的 next-process recovery。
- Stale attempt staging detection 與 ownership-bounded cleanup。
- Cross-process Run／Layout／Pane lease or lock。
- Existing `strategy run` integration、exit codes、sanitization 與 bounded output。
- Deterministic fault injection、synthetic durability benchmark 與 controlled live acceptance。
- `stock_all_list` 652-Symbol Snapshot capacity evidence及單一 baseline endurance run；既有 448 × 3 結果繼續作為 multi-Parameter-Set evidence。

## Out of scope

- `plan.json`、`progress.jsonl`、`checkpoint.json` 或 per-Symbol `result.json`。
- User-configurable retry／backoff policy 或 CLI retry overrides。
- `strategy run` 自動偵測／自動 Resume。
- 產生新的 Run ID 來 Resume 或 continuation。
- 完整 `test:live:strategy` lifecycle runner；留給下一個 Change，但本 Change 需提供可注入 Core seams 與 fault hooks。
- 多 Tabs／Layouts／Panes parallel workers。
- Regular／Deep Backtesting mode 切換。
- Parameter grid search／optimizer。
- Strategy Properties automation，例如 Initial Capital 與 Commission。
- High-level `strategy_run` MCP orchestration tool。
- Database importer／analysis、remote storage、distributed workers 與 scheduler。
- 自動修改或縮減 User 的 Watchlist 內容。

## Capacity and validation fixtures

- 日常 controlled live tests 使用 `dev`／`dev-testing-list`／`TWSE:2330`。
- Synthetic durability benchmark 使用 652 Symbols × 至少 3 Parameter Sets，不依賴 TradingView Desktop。
- Named Watchlist capacity fixture 使用 exact-name `stock_all_list`，目前 expected count 為 652。
- Durable Recovery 完成後只需以單一 baseline Parameter Set 執行 652-Symbol live endurance run；不重複執行 652 × 3。

## Design status

Artifact v2、retry classifier、identity rebind、signal handling、cross-process leases、stale attempt cleanup與不實作`strategy status`皆已定案。唯一仍為`evidence_pending`的是D-014量化benchmark thresholds：先由652 × 3 filesystem prototype取得baseline，再把實測threshold補回[`DECISIONS.md`](./DECISIONS.md)。此項不阻擋module implementation。

## Delivery sequence

```text
Artifact v2 state + durable store
  → lease and retry/atomic Symbol foundations
  → durable Experiment + Parameter Set seams
  → Resume loader/planner/identity rebind
  → Run + Resume orchestration/CLI/signals
  → regression/benchmark/controlled live gate
```

## Acceptance criteria

- [ ] Blocking design decisions皆有明確 decision、理由、rejected alternatives、compatibility impact、failure behavior 與 required tests。
- [ ] Run 開始後直接建立 canonical Run Directory，且 collision behavior 維持不變。
- [ ] `run.json` 與 Experiment `manifest.json` 可在每次 process restart 後決定未完成工作。
- [ ] 每個 Symbol 成功 artifacts 使用 attempt-owned staging + atomic rename，並由 manifest callback commit `succeeded`。
- [ ] Retry 使用固定 3-attempt policy、stable classifier 與 fresh Report A／offset 0。
- [ ] `strategy resume` 沿用同一 `run_id`，只重跑不是 `succeeded` 的 Symbols。
- [ ] Resume 在 identity 相同時繼續工作，在 required identity drift 或 artifact corruption 時安全拒絕。
- [ ] Graceful interruption完成 bounded restore；abrupt crash 可由下一次 Resume 分類與恢復。
- [ ] 相同 Run／Pane 的第二個 mutation process 會在 mutation 前被 lock 拒絕。
- [ ] 652 × 3 synthetic benchmark、fault injection 與完整 deterministic regression 通過。
- [ ] `stock_all_list` Snapshot 完整性及 652-Symbol single-baseline live endurance acceptance 通過。

## Tasks

| ID | Task | Status | Depends on |
| --- | --- | --- | --- |
| [TASK-001](./TASK-001-durable-contract-state-model.md) | Artifact v2 State Model and Durable Run Store | `done` | Strategy Automation Run V1 |
| [TASK-002](./TASK-002-run-pane-leases.md) | Cross-process Run and Pane Leases | `done` | TASK-001 |
| [TASK-003](./TASK-003-symbol-retry-atomic-attempt.md) | Symbol Retry Classifier and Atomic Attempt Export | `done` | TASK-001 |
| [TASK-004](./TASK-004-durable-experiment-execution.md) | Durable Experiment and Parameter Set Execution | `done` | TASK-001, TASK-003 |
| [TASK-005](./TASK-005-resume-planning-identity.md) | Resume Loader, Planning, and Identity Rebind | `done` | TASK-001, TASK-002, TASK-004 |
| [TASK-006](./TASK-006-run-resume-cli-integration.md) | Run／Resume Orchestration, CLI, and Signals | `todo` | TASK-001～005 |
| [TASK-007](./TASK-007-regression-benchmark-live-gate.md) | Regression, Benchmark, and Live Delivery Gate | `todo` | TASK-001～006 |

## Completion record

LLD與implementation task split已完成。TASK-001 artifact v2 state／durable store、TASK-002 Run／Pane leases、TASK-003 Symbol retry／atomic attempt、TASK-004 durable Experiment／Parameter Set execution及TASK-005 Resume planning／identity rebind已完成；TASK-006～007尚未開始。D-014量化threshold將由TASK-007 prototype evidence補齊。
