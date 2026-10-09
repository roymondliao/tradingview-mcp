# Strategy Run Extension — Low-Level Design

Status: `proposed`

## 1. Architecture

```text
strategy run preflight  → standalone adapter ┐
                                               ├→ DurableRunExecutionSpec
strategy extend preflight → extension adapter ┘
  → shared lease/session/watchlist/execution/finalization lifecycle
```

No step writes Parent or ancestor directories。

## 2. Proposed modules

| Module | Responsibility |
| --- | --- |
| `strategy-extension-config.js` | Extension request validation、stable Config comparison、append-only diff。 |
| `strategy-run-lineage.js` | Parent/ancestor bounded loading、cycle detection、lineage fingerprints及aggregation metadata。 |
| `strategy-extend.js` | Dry-run preflight、ownership、child initialization、execution及response。 |
| `strategy-durable-run-lifecycle.js` | Run／Extend共用leases、session、Watchlist validation、execution、restore、finalization及response。 |
| `strategy-run-state.js` | Artifact v4 strict schemas and family-preserving transitions。 |
| `strategy-run-artifacts.js` | V4 store validation、Parent read-only audit、child writes。 |
| `strategy-durable-experiment.js` | Reuse v4 new-only Experiment execution。 |
| `strategy-resume.js` | Accept self-contained v4 extension child without Parent dependency。 |
| `cli/commands/strategy.js` | Register `strategy extend` options and signal/progress wrapper。 |

Core modules不得import CLI handlers。

## 3. Artifact v4

### 3.1 Version constants

```js
STRATEGY_RUN_ARTIFACT_VERSION = 4
STRATEGY_RUN_ARTIFACT_FAMILIES = ['v2', 'v3', 'v4']
```

V2使用legacy `schema_version: 2`；v3／v4使用explicit `artifact_schema_version`。
Family detection以field + exact value dispatch，unknown future versions仍回傳
`RUN_RESUME_VERSION_UNSUPPORTED`。

### 3.2 Standalone v4 `run.json`

```json
{
  "artifact_schema_version": 4,
  "run_kind": "standalone",
  "run_id": "...",
  "status": "running",
  "requested": {
    "config_schema_version": 1
  }
}
```

除`run_kind`外沿用v3 semantics。Standalone不得有`extension`field。

### 3.3 Extension v4 `run.json`

```json
{
  "artifact_schema_version": 4,
  "run_kind": "extension",
  "run_id": "obv-v3-extension-...",
  "status": "running",
  "requested": {
    "config_schema_version": 1,
    "experiments": {
      "parameter_sets": [
        {
          "name": "volume-check",
          "inputs": { "成交量 MA 週期": 15 }
        }
      ]
    }
  },
  "extension": {
    "fingerprint_schema_version": 1,
    "parent_run_id": "obv-v3-20261007T031045Z-c79164b0",
    "parent_artifact_schema_version": 3,
    "parent_run_fingerprint": "sha256:...",
    "lineage_fingerprint": "sha256:...",
    "lineage_depth": 1,
    "inherited_experiment_count": 3,
    "new_experiment_count": 1,
    "inherited_parameter_sets_fingerprint": "sha256:...",
    "requested_parameter_sets_fingerprint": "sha256:...",
    "new_parameter_sets": [
      {
        "name": "volume-check",
        "config_index": 3,
        "lineage_index": 3,
        "run_index": 0
      }
    ]
  }
}
```

Child `requested.experiments.parameter_sets`只是execution delta。Full Config由`config.path`／`config.sha256`
作audit；full sequence及inherited sequence另以fingerprints固定。

### 3.4 Experiment and Manifest v4

Fields沿用v3，只將root版本升為4。Run store必須確保child tree全部同family。Experiment identity仍按
child-local index計算；lineage mapping只存在Run level。

## 4. Parent lineage loading

### 4.1 Direct Parent

`--run-directory`必須：

- Resolve為absolute non-symlink directory。
- Basename must match Parent `run_id`。
- `run.json`、`watchlist.json`、all planned Experiment metadata／manifests完整合法。
- Run status是`succeeded`。
- Summary與manifests derived summary一致。
- 每個succeeded Symbol required artifacts存在。

### 4.2 Ancestors

V2／v3 Parent是root standalone。V4：

- `run_kind: standalone`終止traversal。
- `run_kind: extension`從same output root的`extension.parent_run_id`resolve direct ancestor。
- Reject absolute path、separators、`.`／`..`、symlink及root escape。
- Maintain visited Run IDs/canonical paths，detect cycles。
- Verify stored parent fingerprint against loaded Parent stable Run projection。

Traversal constants：

```js
export const STRATEGY_RUN_LINEAGE_MAX_DEPTH = 64;
export const STRATEGY_RUN_LINEAGE_MAX_EXPERIMENTS = 4096;
export const STRATEGY_RUN_LINEAGE_MAX_JSON_BYTES = 64 * 1024 * 1024;
export const STRATEGY_RUN_LINEAGE_FINGERPRINT_VERSION = 1;
```

`lineage_depth`定義為root standalone到目前Run的Extension edge數：root A = 0、Extension B = 1、
Extension C = 2。建立child時先計算`child_depth = parent_depth + 1`；若大於64，立即回傳
`RUN_EXTENSION_LINEAGE_LIMIT_EXCEEDED`。讀取每個bounded JSON後累計實際bytes；Experiment count或
cumulative JSON bytes超限時亦立即停止，不再讀取下一個ancestor且不連接Desktop。

Traversal只用於Extension preflight及future aggregation；created child Resume不traverse。

### 4.3 Fingerprints

Parent Run fingerprint使用stable JSON SHA-256及下列exact projection：

```text
{
  fingerprint_schema_version: 1,
  run_id,
  artifact_schema_version,
  run_kind,
  status: "succeeded",
  source_sha256,
  candidate_schema_fingerprint,
  target: stableDurableTargetIdentity(resolved.target),
  strategy: stableDurableStrategyIdentity(resolved.strategy),
  base_inputs_fingerprint,
  watchlist: { snapshot_id, ordered_symbol_fingerprint, symbol_count },
  requested_parameter_sets: ordered [{ name, stable requested inputs }],
  planned_experiments: ordered [{
    name,
    requested_inputs_fingerprint,
    inputs_fingerprint
  }]
}
```

不得hash volatile target/tab/entity binding、derived summary formatting或Report／Trades／Reconciliation
payloads。不得包含persisted `experiment_id`，因current Experiment ID schema間接包含runtime `entity_id`。

Lineage fingerprint：

```text
sha256({
  fingerprint_schema_version: 1,
  direct_parent_run_fingerprint,
  parent_lineage_fingerprint,
  inherited_parameter_sets_fingerprint,
  inherited_experiment_count,
  lineage_depth
})
```

Root standalone的`parent_lineage_fingerprint`使用`null`。Extension creation及future Extend重新計算；
child Resume只驗證fingerprint格式與local counts/mapping，不載入Parent。

## 5. Config diff algorithm

```text
load full config parameter sets
load root→parent inherited parameter sets

if config.length < inherited.length:
  EXISTING_EXPERIMENT_CHANGED(delete)

for index in [0, inherited.length):
  compare name + stable requested inputs
  mismatch → EXISTING_EXPERIMENT_CHANGED

new = config.slice(inherited.length)
if new.length === 0:
  NO_NEW_EXPERIMENTS

validate unique new names against ancestors + suffix
map config_index/lineage_index/run_index
```

Comparison必須在CDP connection前完成。

## 6. Stable identity validation

### Local Config checks

- Source file exists、regular、bounded；既有`normalizedPineSourceSha256()`結果equals Parent。Local
  canonical path可不同。
- Saved Strategy name、Layout name、Pane index、Watchlist name、Timeframe、format match Parent。
- Output root canonical path equals`dirname(parent_run_directory)`。

### TradingView checks

- Re-resolve same Saved Layout／Pane。
- Resolve same Strategy script ID/version/source。
- Candidate/runtime Input schema fingerprint equals Parent。
- Current Inputs只允許Parent Base或ancestor planned effective fingerprints，then controlled restore to Base。

Runtime IDs可受控rebind，stable identity不得drift。

若normalized Pine source hash不同，Extension preflight回傳`RUN_EXTENSION_CONFIG_MISMATCH`；User必須建立
new standalone Run。Child保存new Config source absolute path供child Resume使用。

## 7. Planning new Experiments

New suffix透過existing parameter planner，但base catalog由Parent persisted `base_inputs`提供，不capture
current values成為new Base。Planner output轉成child-local plans：

```text
run_index 0 → config/lineage index inherited_count
run_index 1 → config/lineage index inherited_count + 1
```

`extension.new_parameter_sets` mapping與plans name/order必須一致。Setup metadata在child首次
`run.json` write前已complete；Extension不需要standalone Run的post-sync setup window。

## 8. Shared formal lifecycle

Standalone與Extension preflight adapters必須產生同一internal contract：

```js
{
  run_kind,
  run,
  output_directory,
  frozen_watchlist,
  prepared,
  identity,
  context,
  prepare_execution,
}
```

Shared `executePreparedDurableRun()`負責：

```text
acquire child Run then Pane leases
re-read caller-specific preconditions through prepare_execution
exclusive-create store
persist initial Watchlist/run state
open one durable worker Chart Session
validate frozen Symbols
commit complete plans before Parameter mutation
executeDurableStrategyPlan
finalizeDurableStrategyRun
durableStrategyRunResponse
restore/release/error attachment
```

Standalone adapter可在`prepare_execution`中執行Strategy sync及Base capture；Extension adapter只驗證same
source／identity、使用Parent Base並提供new-only plans。Lifecycle不得包含Parent diff或ancestor traversal。

Dry-run只執行對應adapter的read-only preflight／planning，禁止呼叫`executePreparedDurableRun()`。

## 9. Child initialization and durability

Preconditions全部通過後：

1. Acquire child Run lease。
2. Acquire stable Pane lease。
3. Re-read Parent and Config to close TOCTOU；fingerprints必須相同。
4. Exclusive-create child directory。
5. Write copied Watchlist with pending child symbol validation。
6. Write fully planned v4 `run.json(status=running)`。
7. Begin TradingView mutation。

若initial writes在mutation前失敗，可ownership-bounded cleanup自己建立的incomplete child。Abrupt crash留下
incomplete child時，Resume依existing invalid initialization rules拒絕猜測。Parent永遠不cleanup。

## 10. Watchlist behavior

- Copy exact membership／snapshot fields from Parent。
- Child `symbol_validation` starts pending with Parent timeframe。
- Reuse existing validator over frozen symbols，不讀Account Watchlist membership。
- Persist completed child validation before Strategy parameter mutation。
- Failure finalizes child failed；Parent stays succeeded。

## 11. Execution and finalization

Reuse：

- Durable Experiment creation。
- Parameter Set application/readback。
- Per-Symbol retry and attempt staging。
- Manifest transitions and summary derivation。
- Base restore and bounded response。

Child final response增加bounded fields：

```json
{
  "run_kind": "extension",
  "run_id": "child-id",
  "parent_run_id": "parent-id",
  "experiments_inherited": 3,
  "experiments_new": 2,
  "status": "succeeded"
}
```

不輸出ancestor Symbols或combined lineage summary。

## 12. Resume

`readDurableRunArtifacts()`支援v4 strict fields。Child Run已包含delta request、Base、plans、Watchlist及
stable identity，因此existing Resume pipeline只需：

- Validate `run_kind`／extension metadata internal consistency。
- Continue non-succeeded child Symbols。
- Preserve v4 writes。
- Never load or write Parent。
- Never call `strategy-run-lineage.js` or recompute Parent／lineage fingerprints。

Local consistency至少驗證：new suffix length等於requested／planned count、mapping names/order相同、
`run_index`連續、counts相符，以及每個plan identity／fingerprint合法。Parent／lineage fingerprints只驗證
versioned string shape。

## 13. Ownership

- Child Run lease key：child canonical path。
- Pane lease key：Parent stable Layout／Pane identity。
- 不取得Parent Run mutation lease，因Parent read-only且succeeded immutable。
- Lock後必須re-read Parent fingerprint及Config hash，避免extension preflight後被外部替換。
- Release Pane then child Run lease。

## 14. Error behavior

所有Parent／Config／prefix errors發生在Desktop connection前。Runtime identity errors發生在child Directory
create前。只有通過上述preflight後才建立child。

Child已建立後的execution errors沿用existing structured codes並finalize child failed。Response同時包含
`parent_run_id`，但Parent status不變。

## 15. Test matrix

### Pure planner

- One／many new suffix items。
- Delete、rename、inputs change、reorder、middle insertion。
- Duplicate ancestor／suffix names。
- Stable object-key ordering。
- No-op extension。
- Local/config index mapping。

### Artifact and lineage

- V4 standalone／extension strict validation。
- V2／v3 Parent support。
- V4 chain traversal、cycle、missing parent、fingerprint mismatch、symlink／escape。
- Depth 64／65、4096／4097 Experiments及cumulative JSON byte boundaries。
- Mixed family child rejection。
- Parent bounded state files／inventory unchanged；filesystem write spy rejects any Parent-targeted write。

### Execution

- Child contains only new Experiment directories。
- Frozen Watchlist copy and revalidation。
- Parent Base plan/application/restore。
- Retry、fatal error、signal、manifest replacement and finalization faults。
- Child Resume skips succeeded and finishes failed work without Parent read。
- Child Resume succeeds while Parent path is unavailable and lineage loader throws if called。

### Capacity

- Synthetic deep lineage and bounded reader limits。
- Existing 652 × 3 durable benchmark non-regression。
- Controlled live Parent with 3 Experiments + child with at least 2 new Experiments。
