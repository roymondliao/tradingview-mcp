# Strategy Durable Export Recovery LLD

Status: `approved`

## Purpose

本文件依目前 codebase 的實際 module boundaries，定義正式 Strategy Automation Run 的 durable artifact、bounded retry、same-run Resume、process ownership 與 crash recovery architecture。

目標不是重寫 Strategy Trading runtime，而是保留現有已驗證的：

```text
Report A
  → complete Trading Data from offset 0
  → Report B
  → snapshot equality
  → five reconciliation checks
```

並將其外層的 Run transaction、Experiment manifest 與 Symbol artifact commit boundary 改成可在 process restart 後繼續。

## Scope boundary

### In scope

- 正式 `strategy run --config` 的 artifact schema v2 與 direct canonical Run Directory。
- 每個 Symbol attempt 的 bounded retry 與 atomic artifact publish。
- 每個 Experiment `manifest.json` 的 durable state transitions。
- 獨立的 `strategy resume --run-directory` Core／CLI。
- Stable identity validation、Desktop restart target rebind、Run／Pane cross-process locks。
- SIGINT／SIGTERM graceful stop、Base Inputs restore與next-process recovery。
- Deterministic fault injection、652 × 3 synthetic benchmark 與 `stock_all_list` actual 648-Symbol live endurance gate。

### Compatibility boundary

- Run Config 維持 `schema_version: 1`，不新增 `recovery` 欄位。
- `strategy trading-export` 的 single-Symbol／Active Watchlist artifacts 繼續使用既有 V1 `createArtifactSetTransaction()` 與 `partial` status；本 Change 不使該 CLI 可 Resume。
- Trading Report、Trading Data、Snapshot 與 Reconciliation schemas 維持原版本。
- Durable v2 只套用於正式 Strategy Automation Run artifacts。
- V1 Strategy Run artifacts可保留、讀取與人工稽核，但不可原地 Resume。

## Current codebase assessment

| Current module | Existing responsibility | Durable gap／required change |
| --- | --- | --- |
| `src/core/strategy-run.js` | Dry-run preflight、Strategy sync、Parameter Sets、final run summary | 正式 Run 仍建立整棵 random staging tree，最後才 rename；catch 會刪除 staging；需改成 direct durable orchestration，並新增可共用的 Resume execution seam。 |
| `src/core/artifacts.js` | Single-file atomic replace與整棵 artifact-set transaction | `createArtifactSetTransaction()` 適合 terminal publish，不適合 long-running durable Run；保留 legacy behavior，新增 durable store，而不是改變現有 transaction semantics。 |
| `src/core/strategy-trading.js` | Fresh Symbol workflow、streamed Trade export、snapshot/reconciliation、Watchlist loop | `exportStrategySymbolIntoRun()` 已是正確的單一 Symbol workflow，但 artifacts 寫入 run-level staging；需注入 per-attempt writer。Legacy Watchlist loop保留。 |
| `src/core/strategy-parameter-sets.js` | Base Inputs capture、plans、sequential apply、fresh Report、final restore | 目前一次執行全部 Parameter Sets，且 completed results只存在 memory；需支援 persisted plan、selected pending Experiments與 Resume-start Base Inputs restore。 |
| `src/core/strategy-run-config.js` | Strict Config v1、relative paths、source hash、output collision | New Run保持此 preflight；Resume不重新讀 Config，也不能因 Run Directory collision走此入口。 |
| `src/core/strategy-run-resolver.js` | Exact Layout／Saved Strategy／Pane Strategy resolution | 可重用於 Resume stable identity re-resolution；`target_id`／`tab_index`／`entity_id`需視為可 rebind runtime IDs。 |
| `src/core/chart-session.js` | In-process mutex、strict Pane readback、optional Symbol/Timeframe restore | Mutex不能阻擋另一個 CLI process；formal Run／Resume使用worker mode且不restore Chart，legacy callers保留restore。 |
| `src/connection.js` | CDP discovery與 connection-level bounded retries | 已有最多5次 connection retries；durable Symbol retry不再額外把 `CDP_*` 當一般 Symbol transient error，CDP failure終止本 invocation，交由明確 Resume re-resolve。 |
| `src/cli/commands/strategy.js` | `strategy run`與 trading commands | 新增 `strategy resume`，並為 Run／Resume注入 graceful abort signal。 |
| `src/cli/router.js` | JSON output與 exit code 0／1／2 | 新增 explicit signal exit code handling；既有一般與 CDP exit codes保持。 |

## Architecture principles

1. **Manifest is the commit record**：Symbol folder存在不代表成功；只有 Experiment manifest 的 `succeeded` entry可被 Resume 跳過。
2. **One status source per level**：`run.json`負責 Run；每個 `manifest.json`負責 Experiment與Symbols；不新增progress log、checkpoint或result file。
3. **Direct durable root**：Preflight後exclusive-create canonical Run Directory；不再使用整棵 Run random staging。
4. **Atomic at the smallest useful boundary**：JSON state file atomic replace；每個 Symbol三個 artifacts以同filesystem directory rename共同publish。
5. **Retry is execution policy, not artifact data**：Artifact不保存`retryable`；stable classifier只存在codebase。
6. **Resume is explicit**：`strategy run`永遠不自動開啟既有Run；`strategy resume`是唯一 recovery入口。
7. **Stable identity before mutation**：volatile CDP／renderer IDs可重新解析；Saved Layout、Pane selector、script/source/version、Input plans與Watchlist Snapshot不可漂移。
8. **Conservative recovery**：無法證明ownership、identity或artifact完整性時拒絕Resume，不以重新執行掩蓋corruption。
9. **Legacy export isolation**：existing `strategy trading-export` paths維持原contract，durable modules只由formal Run／Resume使用。

## Target dependency architecture

```text
src/cli/commands/strategy.js
  ├── strategy run
  └── strategy resume
            │
            ▼
src/core/strategy-run.js                 New Run application service
src/core/strategy-resume.js              Resume application service
            │
            ├── strategy-run-state.js     Pure v2 schema / transitions / planning
            ├── strategy-run-artifacts.js Durable filesystem store
            ├── strategy-run-retry.js     Fixed policy / classifier / executor
            ├── strategy-run-lease.js     Cross-process Run + Pane ownership
            ├── strategy-run-resolver.js  Stable resource re-resolution
            ├── strategy-sync.js          Idempotent source/account/pane sync
            ├── strategy-parameter-sets.js Persisted/selected plan execution
            └── strategy-trading.js       Existing verified Symbol workflow
                         │
                         ▼
           chart-session.js / pane.js / connection.js
```

No Core module imports CLI handlers. Run與Resume透過相同 durable Experiment與retry services執行。

## Artifact schema versioning

### Version decision

- Run Config：維持version `1`。
- Formal Run artifact：新增`schema_version: 2`。
- `run.json`、`experiment.json`與Experiment `manifest.json`全部使用artifact schema version `2`。
- Report／Trading Data／Reconciliation／Snapshot保留各自既有schema versions。
- Resume只接受完整的artifact v2。
- V1或unknown future version回傳`RUN_RESUME_VERSION_UNSUPPORTED`；本Change不提供migration或in-place rewrite。

V2與V1不相容的原因：V1有`partial`／`completed_at`、run-level staging與terminal-only publication，無法證明中途manifest是否為正式durable commit。

### Canonical directory

```text
<output>/<run-id>/
├── run.json
├── watchlist.json
└── experiments/<parameter-set>/
    ├── experiment.json
    ├── manifest.json
    └── symbols/
        ├── .<safe-symbol>.attempt-<n>.staging/
        └── <safe-symbol>/
            ├── report.json
            ├── trades.json | trades.jsonl | trades.csv
            └── reconciliation.json
```

Run root不再有`publish()`；一旦初始化完成，就是正式可檢查的Run。

### Initialization boundary

New Run的順序：

```text
read-only preflight
  → acquire Run lease
  → acquire Pane lease
  → recheck collision
  → mkdir(<output>/<run-id>, exclusive)
  → atomic write run.json(status=running)
  → atomic write watchlist.json
  → mark durable initialization complete in memory
  → begin TradingView mutation
```

在`run.json`與`watchlist.json`都成功以前，不得執行TradingView mutation。若一般I/O error發生，建立者可在仍持有lease且尚未mutation時刪除自己建立的不完整directory。若OS在兩個initial writes間abrupt crash，該directory是invalid initialization evidence；Resume回傳`RUN_RESUME_ARTIFACT_INVALID`，不猜測或recapture Watchlist。這個極小window沒有TradingView side effect，可由User確認後移除再run。

### `run.json` v2

示意結構：

```json
{
  "schema_version": 2,
  "run_id": "obv-v3-...",
  "status": "running",
  "requested": {},
  "config": {
    "path": "/absolute/run-config.json",
    "sha256": "..."
  },
  "source_sha256": "...",
  "candidate_schema_fingerprint": "...",
  "resolved": {
    "target": {
      "layout_name": "dev",
      "layout_id": "aQoXnpKX",
      "saved_layout_id": 201414175,
      "pane_index": 0,
      "pane_id": "1"
    },
    "strategy": {
      "script_id": "USER;...",
      "version": "3.0",
      "source_sha256": "...",
      "entity_id": "runtime-entity"
    },
    "watchlist": {
      "name": "stock_all_list",
      "snapshot_id": "sha256:...",
      "ordered_symbol_fingerprint": "sha256:...",
      "symbol_count": 648
    }
  },
  "base_inputs": [],
  "base_inputs_fingerprint": {},
  "planned_experiments": [],
  "started_at": 0,
  "started_at_iso": "...",
  "updated_at": 0,
  "updated_at_iso": "...",
  "summary": {},
  "experiments": [],
  "error": null
}
```

Rules：

- Initial `run.json`可暫時沒有post-sync `resolved.strategy`、`base_inputs`與`planned_experiments`；Strategy sync與Base capture成功後必須在任何Parameter mutation前atomic update補齊。
- Resume看到setup metadata尚未完成時，可依persisted `requested`與local source hash重新執行idempotent Strategy sync／Base capture。
- `entity_id`、`target_id`與`tab_index`只作audit；Resume可更新成新runtime binding，但stable target／strategy fields必須匹配。Target不保存Symbol／resolution。
- `status`只允許`running|succeeded|failed`。
- `summary`與`experiments`是derived bounded view；authoritative Symbol detail仍在manifests。
- `updated_at`只在Run-level transition、setup commit、Experiment terminal update與finalization更新，不需每個Symbol重寫`run.json`。
- `error`為`null`或`{ code, phase, message }`；不得保存`retryable`。
- 不保存`completed_at`、`resume_count`或`last_resumed_at`。

### `experiment.json` v2

`experiment.json`是immutable plan／identity，在該Experiment第一次mutation前exclusive-create：

```json
{
  "schema_version": 2,
  "run_id": "...",
  "experiment_id": "sha256:...",
  "parameter_set": {
    "index": 0,
    "name": "baseline",
    "requested_inputs": {},
    "requested_inputs_fingerprint": "..."
  },
  "strategy": {},
  "target": {},
  "base_inputs_fingerprint": {},
  "inputs_fingerprint": {},
  "effective_inputs": [],
  "started_at": 0,
  "started_at_iso": "..."
}
```

Status不寫在`experiment.json`；Experiment status由同directory的`manifest.json`負責。

### `manifest.json` v2

```json
{
  "schema_version": 2,
  "run_id": "...",
  "experiment_id": "sha256:...",
  "parameter_set_name": "baseline",
  "status": "running",
  "strategy": {},
  "inputs_fingerprint": {},
  "watchlist": {
    "snapshot_id": "sha256:...",
    "ordered_symbol_fingerprint": "sha256:...",
    "symbol_count": 648
  },
  "requested_symbols": ["TWSE:1210"],
  "timeframe": "1D",
  "format": "csv",
  "started_at": 0,
  "started_at_iso": "...",
  "updated_at": 0,
  "updated_at_iso": "...",
  "summary": {
    "requested": 648,
    "pending": 651,
    "running": 0,
    "retry_wait": 0,
    "succeeded": 1,
    "failed": 0,
    "skipped": 0
  },
  "symbols": []
}
```

Symbol entry：

```json
{
  "index": 0,
  "requested_symbol": "TWSE:1210",
  "resolved_symbol": "TWSE_DLY:1210",
  "status": "succeeded",
  "attempt_count": 2,
  "updated_at": 0,
  "updated_at_iso": "...",
  "snapshot_id": "sha256:...",
  "total_trades": 12,
  "batch_count": 1,
  "artifacts": {
    "report": "experiments/baseline/symbols/TWSE_u3A_1210/report.json",
    "trades": "experiments/baseline/symbols/TWSE_u3A_1210/trades.csv",
    "reconciliation": "experiments/baseline/symbols/TWSE_u3A_1210/reconciliation.json"
  }
}
```

For `running|retry_wait|failed|skipped`，entry可有：

```json
{
  "error": {
    "code": "SYMBOL_SWITCH_FAILED",
    "phase": "symbol_timeframe_readback",
    "message": "..."
  }
}
```

Rules：

- Frozen Watchlist有項目但`symbols[]`無相同`index`時，狀態為implicit `pending`。
- `index`是primary key；`requested_symbol`必須等於`requested_symbols[index]`。
- 每次attempt開始前先增加累積`attempt_count`並commit `running`。
- `retry_wait`保存最近一次bounded `error`；下一attempt再轉`running`。
- Success commit移除舊error並保存三個artifact paths。
- Summary每次由`requested_symbols`與entries重新derive，Reader必須驗證，不信任不一致的stored count。
- `succeeded` entry的所有artifacts必須存在、為regular files且位於該Symbol final directory。
- Manifest status只有`running|succeeded|failed`。

## Durable filesystem services

### New `strategy-run-state.js`

Pure responsibilities：

```js
validateRunArtifactV2(value)
validateExperimentArtifactV2(value)
validateExperimentManifestV2(value)
transitionRunState(run, transition)
transitionSymbolState(manifest, transition)
deriveManifestSummary(manifest)
deriveRunSummary({ run, manifests })
buildResumePlan({ run, watchlist, experiments, manifests })
```

所有functions回傳new frozen values，不直接讀寫filesystem或連接Desktop。Illegal transition回傳structured `RUN_RESUME_ARTIFACT_INVALID`。

### New `strategy-run-artifacts.js`

Filesystem responsibilities：

```js
createDurableRunStore({ output_directory, run_id })
openDurableRunStore({ run_directory })
readDurableRunArtifacts({ run_directory })
atomicReplaceJson(path, value)
beginSymbolAttempt({ experiment_name, symbol, attempt_count, format })
verifySucceededSymbolArtifacts(entry)
cleanupUncommittedSymbolArtifacts(...)
```

Store methods：

```js
store.writeInitialWatchlist(snapshot)
store.replaceRun(run)
store.createExperiment(experiment)
store.replaceManifest(name, manifest)
store.beginSymbolAttempt(...)
store.artifactInfo(...)
```

Atomic JSON replace：

```text
write same-directory unique temp with flag=wx and flush=true
  → close
  → rename(temp, final)
  → best-effort parent directory sync where supported
```

Node 22 `writeFile(..., { flush: true })`作為file-content flush boundary。Unsupported directory sync不降低atomic visibility；LLD不宣稱可抵抗所有filesystem／hardware corruption，但process crash與normal machine restart後不得產生half-written JSON。

### Symbol attempt store

Attempt path：

```text
experiments/<name>/symbols/.<safe-symbol>.attempt-<attempt-count>.staging
```

- Staging與final Symbol directory是siblings，確保rename不跨filesystem。
- New attempt開始前，在持有Run lease下，清除同Symbol舊staging與manifest未commit的final directory。
- Existing final directory若manifest為`succeeded`，禁止清除或覆寫。
- Report、Trades、Reconciliation全部寫入staging；stream finish後flush open file handles。
- `commit()`驗證三個files後rename完整directory到final path，再sync parent directory。
- Commit後才呼叫manifest success callback。
- `abort()`只刪除目前attempt staging；不修改manifest。

`exportStrategySymbolIntoRun()`的runtime flow保持，僅將artifact path I/O改成注入writer。Legacy adapter仍把writer映射到existing run transaction；durable adapter映射到attempt store。

## Retry design

### Fixed policy

```js
export const STRATEGY_SYMBOL_MAX_ATTEMPTS = 3;
export const STRATEGY_SYMBOL_RETRY_DELAYS_MS = Object.freeze([1000, 2000]);
```

- 每個Run／Resume invocation對每個未成功Symbol有1次initial + 2次retry。
- `attempt_count`是跨invocations cumulative值。
- Invocation local attempt index不persist。
- Tests可注入`delay`與clock；production constants不可由Config、CLI或environment override。

### Classifier

```js
classifyStrategySymbolError(error)
// => retry_symbol | fail_symbol | abort_run
```

Initial allowlist：

| Action | Error codes | Reason |
| --- | --- | --- |
| `retry_symbol` | `SYMBOL_SWITCH_FAILED`, `TIMEFRAME_SWITCH_FAILED`, `STRATEGY_ACTIVATION_FAILED`, `STRATEGY_REPORT_UNAVAILABLE`, `STRATEGY_CALCULATION_TIMEOUT`, `STRATEGY_SNAPSHOT_UNAVAILABLE`, `STALE_STRATEGY_SNAPSHOT`, `TRADING_DATA_INCOMPLETE`, `RECONCILIATION_MISMATCH` | TradingView calculation／readback／snapshot可能是暫時狀況；完整fresh attempt可安全重做。 |
| `fail_symbol` | `SYMBOL_INVALID`, `SYMBOL_REQUIRED` | Request entry本身無效；不需消耗剩餘retry，但可繼續其他Symbols。Formal named Snapshot通常會在preflight先排除此類錯誤。 |
| `abort_run` | `CDP_*`, `PANE_CONTEXT_CHANGED`, `STRATEGY_INPUTS_CHANGED`, `CHART_RESTORE_FAILED`, `PARAMETER_SET_*`, `RUNTIME_INPUT_CATALOG_CHANGED`, `STRATEGY_NOT_FOUND_IN_PANE`, `ENTITY_NOT_STRATEGY`, `TRADING_DATA_SCHEMA_UNSUPPORTED`, `OUTPUT_WRITE_FAILED`, unknown codes | Connection、ownership、identity、schema或local storage已不可信；不可繼續mutation其他Symbols。 |

不讀取`error.retryable`。既有errors可繼續帶該field供legacy callers，但durable artifacts與classifier不依賴它。

CDP `connect()`本身已有connection-level bounded retry。若仍拋出`CDP_*`，本invocation終止；User修復／重啟Desktop後以`strategy resume`重新解析target。Durable layer不在同一attempt內靜默換到active Tab。

### Shared retry executor

```js
executeStrategySymbolWithRetry({
  manifest,
  index,
  symbol,
  signal,
  onTransition,
  beginAttempt,
  executeAttempt,
  cleanupAttempt,
  delay,
})
```

Flow：

```text
for localAttempt 1..3
  → assert not aborted
  → cleanup uncommitted artifacts for this non-succeeded Symbol
  → increment cumulative attempt_count
  → callback manifest=running
  → begin attempt staging
  → execute complete fresh Symbol workflow
  → flush + rename attempt directory
  → callback manifest=succeeded
  → return

on error
  → abort staging
  → classify
  → retry_symbol with budget: callback retry_wait; cancelable delay; continue
  → retry_symbol without budget or fail_symbol: callback failed; return failure
  → abort_run: callback failed; throw
```

Success callback failure不回報success；final directory屬uncommitted，後續Resume會清除後重跑。

## Durable Experiment execution

新增durable Experiment executor；legacy `exportStrategySnapshotIntoRun()`保留給Active Watchlist export。

```js
executeDurableStrategyExperiment({
  store,
  run,
  experiment_plan,
  requested_symbols,
  selected_indices,
  context,
  signal,
  ...runtimeDeps
})
```

Responsibilities：

1. Exclusive-create／validate `experiment.json`。
2. Create or load `manifest.json`。
3. 驗證 Run／Experiment／Watchlist／Inputs fingerprints一致。
4. 只迭代Resume plan選出的indices；`succeeded`永遠不送入retry executor。
5. 每個transition callback立即atomic replace manifest。
6. Symbol retry exhaustion只將該Symbol標為`failed`並繼續下一個Symbol。
7. Identity／CDP／artifact fatal error 將 current Symbol 標為 `failed`、其餘未開始項目標為 `skipped` 或保持 implicit pending，Experiment 轉為 `failed` 並 throw。
8. 全部selected Symbols處理後，若所有requested entries均`succeeded`則Experiment `succeeded`，否則`failed`。
9. Run與Resume外層負責Parameter Set apply以及final Base Inputs restore。

Named Watchlist Snapshot preflight已要求unique symbols；V1 Active Watchlist的duplicate policy不帶入formal durable Run。

## Parameter Set execution changes

目前`executeParameterSets()`在memory內一次capture、plan、execute、restore。Durable Run需拆出可persist的seams：

```js
prepareParameterSetExecution({ candidate_schema, parameter_sets, identity, context })
executePreparedParameterSet({ plan, base, expected_current, ... }, operation)
restorePreparedBaseInputs({ base, identity, context, ... })
```

New Run：

1. Strategy sync完成。
2. Capture Base Inputs並建立全部plans。
3. 在任何Parameter mutation前，把`base_inputs`、fingerprint與`planned_experiments`寫入`run.json`。
4. 依序執行plans。
5. Finally restore Base Inputs。

Resume：

1. 驗證current Pane Inputs fingerprint是persisted Base或任一planned effective fingerprint；其他值視為User／external drift並回傳`RUN_RESUME_IDENTITY_MISMATCH`。
2. Restore persisted Base Inputs。
3. 只執行有未完成Symbols的Experiments；每組effective inputs仍由Base plan計算，不繼承前組邏輯state。
4. Finally restore Base Inputs。

## Resume design

### Public CLI

```bash
npm run tv -- strategy resume \
  --run-directory /absolute/or/relative/path/to/<run-id>
```

- `--run-directory`必填。
- 不接受`--config`、retry override、new Run ID或output override。
- Relative path以current working directory解析。
- CLI response bounded，不包含完整Symbols或Trades。

### Resume phases

```text
1. local_load
   lstat directory; reject symlink/non-directory
   read bounded run.json/watchlist.json/experiment.json/manifests
   validate artifact schema v2, paths, IDs, fingerprints, summaries
   reject succeeded run

2. ownership
   acquire Run lease from persisted absolute run path
   acquire Pane lease from persisted stable pane key
   re-read artifacts after locks to close TOCTOU window

3. runtime_rebind
   read local Pine source and verify persisted hash
   exact-name resolve Layout + pane_index
   resolve Saved Strategy and Pane Strategy
   compare stable identities; adopt volatile target_id/tab_index/entity_id

4. planning
   verify every succeeded Symbol artifact
   build pending indices from manifest status, never folder presence
   succeeded Experiment => no operation
   absent manifest => all frozen Symbols

5. execution
   set run and selected Experiment status=running; update updated_at
   restore Base Inputs
   execute selected Experiments/Symbols with fresh retry budgets
   restore Base Inputs；worker Pane保留最後一個work item的Chart state

6. finalization
   derive summaries from manifests
   all Symbols succeeded => run=succeeded
   any remaining failed/skipped/pending => run=failed
   release Pane then Run lease
```

### Stable and volatile identity

Stable, mismatch rejects Resume：

- `run_id`與resolved Run Directory basename。
- Artifact schema version。
- Persisted requested config內容與config hash audit record的artifact internal consistency。
- Pine source hash。
- `layout_name`。
- `saved_layout_id` when available，otherwise `layout_id`／`url_chart_id`。
- `pane_index` and `pane_id` when available。
- Saved Strategy `script_id`、version與source hash。
- Candidate schema fingerprint。
- Base Input catalog shape／fingerprint及all planned effective fingerprints。
- Watchlist Snapshot ID、ordered fingerprint、count與ordered Symbols。
- Parameter Set index/name/requested inputs／experiment ID。

Volatile, may rebind afterDesktop restart：

- `target_id`
- `tab_index`
- CDP websocket/session identity
- Pane Strategy `entity_id`，但只有在同一Pane恰有一個matching `script_id + version` Strategy且Input schema一致時。
- Current Pane Symbol／timeframe不屬於identity或artifact；runtime discovery可讀取，但execution不保存或restore它們。

Current Inputs values不是任意volatile identity：只接受persisted Base或任一planned effective fingerprint，避免Resume覆寫User在crash後手動修改的Inputs。

Resume不重新讀取或要求原Run Config file仍存在；`run.json.requested`才是後續執行來源，`config.path`／`config.sha256`只作audit。Local Pine source是例外，因Strategy sync／identity仍需要source content，因此必須從persisted `strategy.file_path`重新讀取並驗證hash。

### Local validation rules

- JSON file size需有bounded maximum；超限或malformed回傳`RUN_RESUME_ARTIFACT_INVALID`。
- Reject symlink Run Directory、state files、Experiment directories與Symbol artifacts。
- 所有relative artifact paths通過`assertSafeRelativeArtifactPath()`並resolve containment check。
- `run.json.requested.output.run_path`若存在，必須resolve為目前Run Directory。
- Watchlist symbols、requested symbols與manifest indices需完全一致。
- Manifest `succeeded` entry需驗證三個files；不是`succeeded`的folder不構成success evidence。

## Cross-process ownership

### Lease keys

兩個leases都位於：

```text
<os.tmpdir()>/tradingview-mcp/strategy-leases/
```

Keys：

```text
run:<sha256(canonical absolute run directory)>
pane:<sha256(saved_layout_id-or-layout_id + pane_id-or-pane_index)>
```

不使用`target_id`或`tab_index`作Pane key，因為Desktop restart後會改變。

New Run取得lease時Run Directory尚未建立，因此canonical path由「nearest existing ancestor的realpath + 尚不存在的validated path segments」組成；Resume則直接realpath既有Run Directory。這可避免單純`resolve()`因symlink alias產生兩個不同Run locks。

### Atomic acquisition

- 使用`mkdir(lockDirectory, { recursive: false })`取得ownership。
- `owner.json`包含version、random owner token、pid、process start timestamp、run ID、scope、stable key、acquired／heartbeat timestamps。
- Acquisition order固定 Run → Pane；release order Pane → Run，避免deadlock。
- 取得lease後再重新讀local artifacts／runtime identity，關閉TOCTOU window。
- 同一process內既有`chartMutationMutex`繼續保留。

### Stale reclaim

- `process.kill(pid, 0)`成功或`EPERM`：視為live，回傳`RUN_ALREADY_ACTIVE`。
- `ESRCH`：owner process不存在，可atomic rename lock directory到tokenized quarantine後再競爭mkdir。
- Corrupt／unreadable owner metadata：不得只依mtime刪除，回傳`RUN_ALREADY_ACTIVE`並要求人工檢查。
- Heartbeat只作diagnostic，不單獨作stale判斷。
- Release前比對owner token；不得刪除另一個process重新取得的lease。

## Signal and abrupt crash behavior

### First SIGINT／SIGTERM

- CLI-owned `AbortController` aborts；Core不直接註冊global process handler。
- 不開始下一個attempt／Symbol／Experiment。
- Retry backoff立即cancel。
- 已開始的CDP phase不以detached Promise強制中斷，而是依現有bounded timeout結束。
- `finally`執行Base Inputs restore；不執行Chart Symbol／timeframe restore。
- 可完成state write時，current Experiment／Run轉`failed`，error code為`RUN_INTERRUPTED`。
- Release leases。
- CLI exit code：SIGINT `130`，SIGTERM `143`。

### Repeated signal

第二個signal立即以128 + signal number退出，不再保證restore、state update或lease release；後續Resume依最後durable manifest與stale-owner rules恢復。

### SIGKILL／process crash／Desktop crash／power loss

- 無finally guarantee。
- Run／Experiment通常保留`running`。
- Symbol可能保留`running`、staging directory或rename後未commit final directory。
- Next Resume取得stale lease後，以manifest為準cleanup並重跑非`succeeded` Symbol。

## Error contract

Resume-specific errors：

| Code | Phase | Behavior |
| --- | --- | --- |
| `RUN_RESUME_NOT_FOUND` | `resume_load` | Run Directory或`run.json`不存在。 |
| `RUN_ALREADY_SUCCEEDED` | `resume_validation` | 不連接Desktop、不mutation。 |
| `RUN_ALREADY_ACTIVE` | `run_lease`／`pane_lease` | 不等待；bounded error。 |
| `RUN_RESUME_VERSION_UNSUPPORTED` | `resume_validation` | V1／unknown schema不可修改。 |
| `RUN_RESUME_ARTIFACT_INVALID` | `resume_validation` | Missing、malformed、symlink、path escape、summary mismatch或succeeded artifacts corruption。 |
| `RUN_RESUME_IDENTITY_MISMATCH` | `resume_identity` | Stable runtime/source/Input identity drift。 |
| `RUN_INTERRUPTED` | `signal` | Graceful SIGINT／SIGTERM final state。 |

Runtime／restore errors沿用既有codes。Persisted `error`一律sanitize為：

```js
{ code, phase, message }
```

Message限制1000 characters；不保存stack、cause、raw TradingView payload或`retryable`。

## Run and Resume finalization

### Successful completion

- Every requested Experiment manifest is`succeeded`。
- Every requested Symbol entry is`succeeded`且artifact verification通過。
- Base Inputs restore成功。
- Atomic replace `run.json`為`succeeded`並更新summary／updated_at。

### Failed completion

- Retry exhaustion可繼續其他Symbols，但Experiment與Run最後是`failed`。
- Fatal identity／CDP／artifact／Base Inputs restore error停止本invocation並將Run標為`failed`；未開始工作保留pending或skipped。
- 若state write本身失敗，回傳原始／state error，disk上的最後valid status可能仍是`running`；Resume local validation必須處理。
- 不使用`partial`。

### Bounded CLI response

```json
{
  "success": false,
  "run_id": "...",
  "status": "failed",
  "mode": "run|resume",
  "output": {
    "path": "...",
    "durable": true,
    "atomic_scope": "state_file_and_symbol_directory"
  },
  "summary": {
    "experiments_requested": 3,
    "experiments_succeeded": 2,
    "experiments_failed": 1,
    "symbols_requested": 1956,
    "symbols_succeeded": 1955,
    "symbols_failed": 1,
    "symbols_pending": 0
  },
  "retry_supported": true,
  "resume_supported": true
}
```

Response不包含完整manifest、Symbols或attempt history。

## Optional `strategy status`

本Change不實作`strategy status`。理由：

- `run.json`與manifests已是human／tool readable local state。
- Resume loader必須有local summary function，但不需要立即增加public CLI surface。
- 後續若實際操作需要，可用相同reader另開Change加入完全read-only command。

因此status command不阻擋Durable Run／Resume delivery。

## Module change map

### New modules

- `src/core/strategy-run-state.js`
- `src/core/strategy-run-artifacts.js`
- `src/core/strategy-run-retry.js`
- `src/core/strategy-run-lease.js`
- `src/core/strategy-resume.js`

### Modified modules

- `src/core/strategy-run.js`
  - Replace run-level transaction with durable store。
  - Persist setup before mutation。
  - Share execution service with Resume。
  - Use failed/succeeded terminal model。
- `src/core/strategy-trading.js`
  - Extract/inject Symbol artifact writer seam。
  - Keep legacy single/Watchlist exporters on V1 transaction。
- `src/core/strategy-parameter-sets.js`
  - Split prepare／selected execution／restore seams。
  - Persistable plans and Resume from Base。
- `src/core/index.js`
  - Export new Core namespaces。
- `src/cli/commands/strategy.js`
  - Add `strategy resume` and AbortController wrapper。
- `src/cli/router.js`
  - Honor structured 130／143 signal exit codes without changing normal 0／1／2 behavior。
- `package.json`
  - Add new deterministic test files to `test:unit`／`test:all`。

### Existing modules kept compatible

- `src/core/artifacts.js` keeps `createArtifactSetTransaction()` forlegacy exporters。
- `src/core/strategy-run-config.js` keeps Config v1 and collision validation。
- `src/core/chart-session.js` keeps in-process mutex and strict readback。
- `src/connection.js` keeps existing connection-level retry behavior。

## Verification strategy

### Pure state tests

- All legal／illegal Run、Experiment、Symbol transitions。
- Summary derivation and manifest consistency validation。
- Resume planning skips only`succeeded`。
- V1／unknown schema structured rejection。
- Stable／volatile identity comparison。
- Retry classifier has exhaustive table tests；unknown defaults to`abort_run`。

### Filesystem fault tests

Inject failure/crash at：

1. Run directory mkdir。
2. Initial watchlist write。
3. Initial run write。
4. Manifest temp write／flush／rename。
5. Trades stream start／batch／finish／flush。
6. Report／reconciliation writes。
7. Symbol staging rename。
8. Manifest success callback。
9. Final Run update。
10. Lease acquisition／stale reclaim／token-checked release。

每個case驗證下一次Resume的deterministic action，且不混用attempt artifacts。

### Retry tests

- Success on attempts 1／2／3。
- Retry exhaustion marks failed and continues next Symbol。
- Resume gets fresh 3-attempt budget while cumulative count grows。
- Nonretryable Symbol error不sleep。
- Abort error不執行next Symbol。
- AbortSignal cancels backoff。

### Integration tests

- New Run direct canonical directory，collision仍blocked。
- Crash留下running state；Resume同Run ID只執行unfinished Symbols。
- Succeeded artifact missing拒絕Resume。
- Desktop target／entity volatile IDs rebind成功。
- Source、Layout、Pane、Strategy version、Inputs或Watchlist drift拒絕。
- Duplicate Run／Pane processes在mutation前blocked。
- SIGINT graceful Base Inputs restore；second signal／simulated hard crash由Resume恢復。
- Existing single-Symbol／Active Watchlist V1 tests不回歸。

### Capacity and live gates

- Synthetic fixture：652 Symbols × 3 Parameter Sets，包含每Symbol manifest transitions、attempt staging、atomic rename、final audit與Resume planning。
- Task先記錄baseline，再依CI／developer hardware evidence在`DECISIONS.md`填入D-014 thresholds；不得先捏造任意數字。
- Controlled live：小型list驗證retry與Resume。
- Final live：exact-name `stock_all_list` actual 648，單一baseline endurance Run，648/648 succeeded。
- Existing 448 × 3 manual result作為multi-Parameter-Set live evidence，不重跑652 × 3 live。

## Delivery sequence

```text
TASK-001 Artifact v2 state + durable store
      │
      ├──────────────┐
      ▼              ▼
TASK-002 Lease   TASK-003 Retry + atomic Symbol attempt
      │              │
      └──────┬───────┘
             ▼
TASK-004 Durable Experiment + Parameter Set seams
             │
             ▼
TASK-005 Resume loader / planner / identity rebind
             │
             ▼
TASK-006 Run + Resume orchestration / CLI / signals
             │
             ▼
TASK-007 Regression / benchmark / controlled live gate
```

Task contracts見同directory的`TASK-001`～`TASK-007`。
