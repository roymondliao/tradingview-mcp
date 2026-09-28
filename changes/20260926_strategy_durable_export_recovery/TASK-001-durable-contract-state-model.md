---
id: TASK-001
title: Durable Contract and State Model
status: discussion
phase: strategy-durable-export-recovery
depends_on:
  - FEATURE-20260915-STRATEGY-AUTOMATION-RUN
blocks:
  - implementation-task-breakdown
scope: design-and-prototype
---

# TASK-001: Durable Contract and State Model

## Goal

在修改 production orchestration 或 artifact writer 前，以現有 Run artifact structure 為基礎，完成 Strategy Durable Export Recovery 尚未定案的 schema、retry classification、identity rebind、signal、lock、cleanup 與 validation contracts；再以 filesystem-only prototype 驗證 crash recoverability 與 652 × 3 workload shape，最後產生 LLD 與後續 implementation tasks。

本 Task 不再討論已否決的額外 progress files、per-Symbol result files、random run-level staging 或 User-configurable retry policy。

## Confirmed contract to preserve

### Artifact ownership

```text
<output>/<run-id>/run.json
  → Run status and original execution identity

<output>/<run-id>/watchlist.json
  → Frozen ordered Symbol input

<output>/<run-id>/experiments/<parameter-set>/manifest.json
  → Experiment and Symbol status source

<output>/<run-id>/experiments/<parameter-set>/symbols/<safe-symbol>/
  → Successful report / trades / reconciliation artifacts
```

- 不新增 `plan.json`、`progress.jsonl`、`checkpoint.json` 或 `result.json`。
- Folder presence 不代表 Symbol success；`manifest.json` 是唯一 status source。
- Manifest 標示 `succeeded` 但 artifacts 缺漏時屬 corruption，不得 silent rerun。

### Run lifecycle

- Read-only preflight 不落地 artifacts。
- Preflight 成功後 exclusive-create canonical Run Directory，立即以 `running` 建立 `run.json`。
- 不再使用 random run-level staging directory。
- `strategy run` 對 existing Run Directory 保持 `RUN_OUTPUT_EXISTS`。
- Run／Experiment public status 只有 `running`、`succeeded`、`failed`。
- Abrupt crash 保留最後一次 atomic status，通常是 `running`。
- 只使用 `started_at`／`started_at_iso` 與會更新的 `updated_at`／`updated_at_iso`；不新增 completed／resume metadata。

### Symbol lifecycle

| Current condition | Durable Symbol state | Next action |
| --- | --- | --- |
| Frozen Watchlist 有項目、manifest 無 entry | implicit `pending` | Run／Resume 建立 attempt。 |
| Attempt 即將 mutation TradingView | `running` | 執行完整 Symbol workflow。 |
| Attempt 失敗且本 invocation 尚有 retry budget | `retry_wait` | Cancelable backoff 後重新從 Report A 開始。 |
| Artifacts atomic publish 且 success callback committed | `succeeded` | 後續 Resume 永遠跳過，並驗證 artifacts。 |
| Attempt 執行過但本 invocation 不再 retry | `failed` | 後續 Resume 取得新 budget。 |
| Run／Experiment abort 導致未執行完成 | `skipped` | 後續 Resume 視為未完成。 |

每個 Symbol 保存累積 `attempt_count` 與單一 `error: { code, phase, message }`。不保存 `retry_exhausted` 或 `retryable`。

### Per-Symbol atomic commit

```text
manifest = running
  → full Report A / Data offset 0 / Report B / reconciliation
  → write and close attempt-owned sibling staging
  → atomic rename to final Symbol directory
  → callback atomically updates manifest = succeeded
```

- Rename 後、callback 前 crash 時，manifest 仍未成功；Resume cleanup／isolate uncommitted folder 後重新執行。
- 每次 state transition 都以 callback 更新 manifest，並由 same-directory temp file + atomic replace 落地。
- Staging 與 final directory 必須在同一 filesystem。

### Retry and Resume

```text
STRATEGY_SYMBOL_MAX_ATTEMPTS = 3
STRATEGY_SYMBOL_RETRY_DELAYS_MS = [1000, 2000]
```

- Policy 是 production constants；Run Config 與 CLI 都不可修改。
- Run／Resume 共用 Symbol retry executor。
- 每次 Resume invocation 對每個未成功 Symbol 取得新的 3-attempt budget。
- Durable `attempt_count` 跨 invocations 累積。
- Retry classifier 使用 stable internal error codes，不讀 artifact 的 `retryable` boolean。
- 每個 attempt 都重新執行完整 Symbol workflow，不能接續上次 Data offset 或混用 Report snapshots。

Resume 是獨立 Core module／CLI：

```bash
npm run tv -- strategy resume --run-directory <output>/<run-id>
```

- 沿用原本 Run ID、directory、config、Watchlist Snapshot、Parameter Sets 與 experiment IDs。
- 不建立 derived／continuation run。
- `succeeded` Experiment 全部跳過。
- 其他 Experiment 只排入不是 `succeeded` 的 Symbols；沒有 manifest 的 Experiment 執行完整 frozen Watchlist。
- `strategy run` 不自動偵測或執行 Resume。
- 取得 ownership 且通過 validation 後，原 Run 與待執行 Experiment 回到 `running` 並更新 `updated_at`；不新增 Resume 專屬 status／timestamp／counter。

## Remaining requirements

### In scope

- 完成 [`DECISIONS.md`](./DECISIONS.md) 中仍為 `open` 的 D-002、D-007、D-008、D-011～D-015。
- 固定 artifact schema version、V1 compatibility／migration 與 unknown version behavior。
- 固定 stable retry classifier、Run-abort classification 與 CDP reconnect attempt semantics。
- 固定 Resume stable／volatile identity 與 Desktop restart rebind rules。
- 固定 SIGINT／SIGTERM、abrupt crash 與 cancelable backoff contract。
- 固定 cross-process Run／Pane lock 與 stale-owner reclaim contract。
- 固定 stale attempt staging／uncommitted final folder cleanup contract。
- 決定是否需要獨立的 local read-only `strategy status` command。
- 以 filesystem-only prototype 驗證 manifest atomic replacement、attempt staging 與 identified crash windows。
- 量測 652 Symbols × 3 Parameter Sets 的 time／memory／disk／manifest size／Resume planning latency。
- 產生完整 LLD、fault matrix、artifact examples 與依賴清楚的 implementation task files。

### Out of scope

- 修改 `strategy run` production behavior。
- 在本 Task 新增正式 `strategy resume` 或 automatic retry。
- 加入新的 public Run Config recovery fields。
- 新增第二套 progress／checkpoint／result persistence。
- Live TradingView mutation 或 652-Symbol endurance run。
- 完整 `test:live:strategy` lifecycle runner。

## Design constraints

- Existing Run Config、Strategy sync、Watchlist snapshot、Parameter Sets、Trading Data normalization 與 reconciliation contracts 不得回歸。
- State recovery 不得依賴 in-memory object、Symbol folder presence、wall-clock guess 或未驗證的 Desktop state。
- Experiment／Parameter Set 與 ordered Watchlist entry 都是 durable identity 的一部分。
- Artifact cleanup、lock reclaim 與 successful artifact reuse 都必須先證明 ownership／identity。
- Resume local artifact validation 失敗時，不得建立 CDP session 或 mutation TradingView。
- Bounded CLI／MCP response 不輸出完整 Symbols、Trades 或 unbounded history。
- Tests 可注入 clock、delay、filesystem failure 與 crash hooks，但 production retry constants 不可配置。

## Required prototype questions

1. Manifest atomic replace 前後 crash，各自保留哪一份 valid state？
2. Symbol staging write／close／rename／success callback 每個 crash window 如何 deterministic recovery？
3. Manifest 為 `succeeded` 但 report／trades／reconciliation 任一缺失或 hash 不符時，如何拒絕 Resume？
4. Rename 已成功但 manifest 未 commit 時，如何證明 uncommitted final folder ownership並安全 cleanup？
5. 同一 Run 或同一 Pane 的 duplicate Resume／Run process 如何在 mutation 前被拒絕？
6. Desktop restart 後哪些 runtime identifiers 可以 re-resolve，哪些 stable identity mismatch 必須拒絕？
7. 652 × 3 在每個 Symbol state transition 重寫 manifest 的 time／memory／disk evidence 為何？

## Resume error contract

Prototype／LLD 必須使用下列已確認 errors：

| Code | Scope |
| --- | --- |
| `RUN_RESUME_NOT_FOUND` | Run Directory／`run.json` missing。 |
| `RUN_ALREADY_SUCCEEDED` | Run 已完成。 |
| `RUN_ALREADY_ACTIVE` | 另一個 live owner。 |
| `RUN_RESUME_VERSION_UNSUPPORTED` | Unsupported artifact schema。 |
| `RUN_RESUME_ARTIFACT_INVALID` | Missing／malformed／inconsistent durable artifacts。 |
| `RUN_RESUME_IDENTITY_MISMATCH` | Current stable identity mismatch。 |

Runtime／restore failures 沿用既有 error codes，不建立 Resume-prefixed duplicates。

## Verification and delivery

### Acceptance criteria

- [ ] D-002、D-007、D-008、D-011～D-015 全部定案，沒有 blocking `open` decision。
- [ ] 每項 decision 記錄 rationale、rejected alternatives、compatibility impact、failure behavior 與 required tests。
- [ ] Versioned artifact examples 能表示 `running`、`succeeded`、`failed` Run／Experiment 與所有 Symbol states。
- [ ] Durable ordering 對 write、close、rename、manifest callback 與 process crash 有 deterministic recovery rule。
- [ ] V1 artifact compatibility 與 unsupported Resume behavior 明確。
- [ ] Retry／Resume 不會混用 attempt、snapshot、Experiment、Inputs 或 Strategy identity。
- [ ] Cross-process lock 與 stale reclaim 不只依賴 mtime，也不會無限等待。
- [ ] 652 × 3 filesystem-only prototype 產生可重現 benchmark evidence，並據此定義 thresholds。
- [ ] LLD、fault matrix、error taxonomy、CLI contract 與 artifact examples 完成 review。
- [ ] 後續 implementation tasks 已拆分，且每個 Task 有單一 ownership boundary 與 acceptance criteria。
- [ ] `git diff --check` 通過；本 Task 沒有 production behavior change。

### Deliverables

- `LLD.md`
- Versioned Run／Experiment／Manifest artifact examples
- Filesystem-only durability prototype與 benchmark results
- Fault-window recovery matrix
- Finalized implementation task set

## Completion record

Design discussion in progress. D-001、D-003～D-006、D-009 與 D-010 已定案；其餘 Open decisions 需完成後才能拆分 production implementation tasks。
