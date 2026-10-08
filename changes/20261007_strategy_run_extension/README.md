---
id: FEATURE-20261007-STRATEGY-RUN-EXTENSION
title: Strategy Run Extension
status: implementation
created: 2026-10-07
depends_on:
  - FEATURE-20260926-STRATEGY-DURABLE-EXPORT-RECOVERY
  - FEATURE-20261006-STRATEGY-RUN-SCHEMA-NAMING
scope:
  - append-only-experiments
  - immutable-parent-lineage
  - extension-run-directory
  - artifact-schema-v4
---

# Strategy Run Extension

Status: `implementation`

## Objective

允許User完成一個Formal Strategy Run、分析既有Experiments後，在原Run Config的
`experiments.parameter_sets`尾端新增一或多個Parameter Sets，並只執行新增的
Experiments。既有成功Run保持immutable；Extension建立新的durable Run Directory，
保存Parent lineage與新增Experiments，不複製Parent的Report／Trades／Reconciliation。

Proposed CLI：

```bash
tv strategy extend \
  --run-directory ./temp/output/obv-v3-20261007T031045Z-c79164b0 \
  --config ./temp/tv-strategy-run-positive.json
```

Dry-run：

```bash
tv strategy extend \
  --run-directory ./temp/output/obv-v3-20261007T031045Z-c79164b0 \
  --config ./temp/tv-strategy-run-positive.json \
  --dry-run
```

`--run-directory`提供authoritative Parent evidence；`--config`代表User期望的完整
lineage Parameter Set sequence。Extension planner比較兩者，只將append-only suffix列為
new Experiments。

## User workflow

Initial Config：

```json
{
  "schema_version": 1,
  "experiments": {
    "parameter_sets": [
      { "name": "baseline", "inputs": {} },
      {
        "name": "candidate-check",
        "inputs": { "wOBV 平滑 MA 週期": 12, "趨勢 SMA 週期": 20 }
      },
      {
        "name": "rsi-check",
        "inputs": { "RSI 週期": 20, "RSI 最低門檻": 30 }
      }
    ]
  }
}
```

完成Parent Run並分析結果後，在同一份Config尾端加入：

```json
{
  "name": "volume-check",
  "inputs": {
    "成交量 MA 週期": 15
  }
}
```

Planner結果：

```text
baseline         inherited, exact match required
candidate-check  inherited, exact match required
rsi-check        inherited, exact match required
volume-check     new, execute in Extension Run
```

如果把`candidate-check`的值直接從12改成14，不視為new Experiment，必須拒絕。
User應保留原項目並新增不同名稱，例如`candidate-check-v2`。

完整Config contract見[`EXTENSION_CONFIGURATION.md`](./EXTENSION_CONFIGURATION.md)。

## Directory model

```text
<output>/
├── obv-v3-20261007T031045Z-c79164b0/       # Parent, immutable
│   ├── run.json
│   ├── watchlist.json
│   └── experiments/
│       ├── baseline/
│       ├── candidate-check/
│       └── rsi-check/
│
└── obv-v3-extension-20261008T.../          # Extension, independently resumable
    ├── run.json
    ├── watchlist.json
    └── experiments/
        └── volume-check/
            ├── experiment.json
            ├── manifest.json
            └── symbols/
```

Parent artifacts不複製到Extension。Extension只重複bounded evidence：

- Frozen ordered Watchlist及Snapshot identity。
- Pine source／Candidate schema fingerprints。
- Parent Base Inputs及fingerprint。
- Stable Layout／Pane／Strategy identity。
- Parent lineage fingerprint與inherited Experiment count。

Extension `run.json.summary`只計算本次新增Experiments。完整lineage summary由consumer讀取
Parent chain後動態組合，不在每個child複製ancestor summaries。

## Parent and Config authority

| Concern | Authority |
| --- | --- |
| Existing Parameter Sets | Parent lineage persisted requests |
| Existing Experiment identity | Ancestor `planned_experiments` |
| Base Inputs | Parent persisted `base_inputs` and fingerprint |
| Strategy source/schema | Parent hashes and current verified runtime |
| Symbol universe | Parent frozen Watchlist Snapshot |
| Desired complete Experiment sequence | New `--config` |
| New Experiment suffix | Deterministic Parent/Config diff |

Original Parent Config file不是authority，也不要求仍存在。Extension只信任Parent durable
artifacts；`--config`是新的proposal。

## Shared Run／Extend lifecycle

`strategy run`與`strategy extend`只有preflight／planning來源不同，不得各自複製一套durable
execution：

```text
strategy run preflight
  → standalone preparation adapter
                             ┐
                             ├→ DurableRunExecutionSpec
                             │   → shared lease/session/watchlist/execution/finalization lifecycle
strategy extend preflight   │
  → Parent diff adapter ─────┘
```

Common execution spec至少包含：

```text
run kind and initial artifact
child store target
frozen Watchlist
prepared Parameter Set plans
resolved Strategy identity and Pane context
signal/progress/status callbacks
```

`--dry-run`使用與formal execution相同的standalone／extension preflight及planning functions，只是不建立
store、不取得mutation ownership且不呼叫shared execution lifecycle。

## Append-only rules

令Parent lineage已有`P`個Parameter Sets，extended Config共有`C`個：

```text
C must be greater than P
config.parameter_sets[0:P] must exactly equal inherited parameter sets
config.parameter_sets[P:C] is the non-empty new suffix
```

Exact equality包含：

- Parameter Set name。
- Requested Input key/value pairs，以stable JSON比較。
- Sequence position。

不允許：

- 修改、刪除或重新命名existing Parameter Set。
- Reorder existing Parameter Sets。
- 在existing prefix中插入Parameter Set。
- New name與任何ancestor或同一suffix重複。
- Zero-new Experiment extension。

Child Run內部仍使用local indexes `0..N-1`，lineage metadata另保存每個new Experiment的
`config_index`／`lineage_index`，避免全面改寫既有execution code的array-index contract。

## Artifact versioning

Extension需要在`run.json`正式保存`run_kind`與lineage metadata，不能在strict artifact v3
下偷偷加入欄位。因此本Feature規劃formal artifact v4：

```json
{
  "artifact_schema_version": 4,
  "run_kind": "extension",
  "extension": {
    "fingerprint_schema_version": 1,
    "parent_run_id": "obv-v3-20261007T031045Z-c79164b0",
    "parent_artifact_schema_version": 3,
    "parent_run_fingerprint": "sha256:...",
    "lineage_depth": 1,
    "inherited_experiment_count": 3,
    "new_experiment_count": 1,
    "inherited_parameter_sets_fingerprint": "sha256:...",
    "requested_parameter_sets_fingerprint": "sha256:...",
    "new_parameter_sets": [
      {
        "name": "volume-check",
        "config_index": 3,
        "run_index": 0
      }
    ]
  }
}
```

New standalone `strategy run`也升級為v4並寫`run_kind: "standalone"`，使current writer只有一套
formal artifact version。Existing v2／v3 Resume維持format-preserving behavior。

## Extension lifecycle

1. Bounded read Parent Run Directory與所有ancestor lineage metadata。
2. Parent必須是完整、合法、`succeeded`的v2／v3／v4 Run。
3. Strictly load extended Config v1及local Pine source。
4. 驗證Config stable fields與Parent相同。
5. 執行append-only Parameter Set diff；new suffix必須non-empty。
6. Resolve current TradingView stable identity及Candidate Input schema，尚未mutation。
7. 以Parent Base Inputs驗證及建立new Experiment plans。
8. Acquire new child Run lease及Parent stable Pane lease。
9. Exclusive-create child Run Directory。
10. Persist copied frozen Watchlist與fully planned v4 `run.json` before mutation。
11. Revalidate frozen Symbols against TradingView without recapturing Watchlist membership。
12. Execute only new Experiments through the shared durable Run lifecycle。
13. Restore Parent Base Inputs、finalize child Run、release leases。

Parent Directory全程read-only。

## Resume behavior

Extension child是一個self-contained durable Run：

```bash
tv strategy resume --run-directory <extension-run-directory>
```

Resume只處理child的new Experiments，不修改、不尋找也不重讀Parent。Parent path及original extended
Config不屬於Resume runtime dependency；child已保存source path/hash、Base Inputs、Watchlist與plans。
Lineage fingerprints在Resume中是provenance evidence，只驗證field shape、counts及child-local mapping；
完整fingerprint只在建立下一個Extension或lineage aggregation時載入ancestors後重新驗證。

若child已`succeeded`，仍回傳`RUN_ALREADY_SUCCEEDED`。

## Chained extensions

一個成功Extension可以成為下一個Extension的Parent：

```text
Standalone Run A
  └── Extension B
        └── Extension C
```

Config每次都提供完整desired sequence；planner沿ancestor chain組合inherited Parameter Sets後做
exact-prefix comparison。Branching lineage允許存在，但name uniqueness只保證ancestor chain；第一版
不掃描sibling Run Directories。

`lineage_depth`是root standalone到目前Run的Extension edge數（A=0、B=1、C=2）。建立下一個child時，
planner以`parent_depth + 1`檢查以下fixed bounds：

```text
STRATEGY_RUN_LINEAGE_MAX_DEPTH = 64
STRATEGY_RUN_LINEAGE_MAX_EXPERIMENTS = 4096
STRATEGY_RUN_LINEAGE_MAX_JSON_BYTES = 64 MiB cumulative
STRATEGY_RUN_LINEAGE_FINGERPRINT_VERSION = 1
```

這些limits只適用`strategy extend`及lineage aggregation；child `strategy resume`不traverse lineage，
因此不受Parent availability或depth影響。

## Safety properties

- Parent及ancestor directories不得被寫入、rename、cleanup或重新finalize。
- Extension只能從`succeeded` Parent建立；failed/running Parent應先Resume。
- Child directory在任何TradingView mutation前包含complete frozen identity與new plans。
- Existing prefix mismatch不得連接或mutation TradingView。
- Frozen Watchlist membership不得重新擷取；只重新驗證相同ordered Symbols。
- Parent Base Inputs是new Experiment effective values的唯一baseline。
- Parent與Extension的Pine identity必須有相同`saved_name`及normalized source SHA-256；local file path可不同。
- Child summary與artifacts只涵蓋new Experiments。
- Child collision沿用`RUN_OUTPUT_EXISTS`且不修改existing output。
- v2／v3 Parent artifacts不做migration或in-place rewrite。
- Extension不宣稱凍結market data；若Strategy未限定回測時間，時間經過可能影響結果可比性。

## In scope

- `strategy extend --run-directory --config [--dry-run]`。
- Artifact v4 standalone／extension discriminator及lineage contract。
- Parent/ancestor bounded loader、fingerprints及append-only diff。
- New child Run Directory與new-Experiments-only execution。
- Frozen Watchlist reuse及current Symbol revalidation。
- Parent Base Inputs reuse、runtime identity/schema revalidation及restore。
- Extension child的existing `strategy resume` support。
- Deterministic tests、fault injection、synthetic benchmark及controlled live acceptance。

## Out of scope

- 修改成功Parent Run或將new Experiments寫入Parent directory。
- 重新執行existing Experiments。
- 修改／刪除／reorderexisting Parameter Sets。
- 自動搜尋sibling Extensions或禁止lineage branches。
- Lineage result aggregation／comparison／ranking command。
- Copy、hard-link或symlink Parent Symbol artifacts到child。
- Database、remote storage或distributed lineage registry。
- Market data snapshotting或保證不同執行時間的行情資料完全相同。

## Error taxonomy

| Code | Meaning |
| --- | --- |
| `RUN_EXTENSION_PARENT_NOT_FOUND` | Parent directory／required artifacts不存在。 |
| `RUN_EXTENSION_PARENT_NOT_SUCCEEDED` | Parent不是`succeeded`。 |
| `RUN_EXTENSION_LINEAGE_INVALID` | Parent lineage malformed、cycle、fingerprint mismatch或path不安全。 |
| `RUN_EXTENSION_LINEAGE_LIMIT_EXCEEDED` | Lineage depth、Experiment count或cumulative JSON bytes超過fixed bound。 |
| `RUN_EXTENSION_CONFIG_MISMATCH` | Non-Experiment stable Config fields與Parent不同。 |
| `RUN_EXTENSION_EXISTING_EXPERIMENT_CHANGED` | Existing prefix有修改、刪除、插入或reorder。 |
| `RUN_EXTENSION_NO_NEW_EXPERIMENTS` | Config沒有non-empty new suffix。 |
| `RUN_EXTENSION_DUPLICATE_EXPERIMENT` | New name與ancestor或suffix重複。 |
| `RUN_EXTENSION_IDENTITY_MISMATCH` | Current TradingView stable identity/schema與Parent不同。 |
| `RUN_OUTPUT_EXISTS` | Child Run ID/output directory collision。 |

Config自身syntax／Inputs validation仍沿用`RUN_CONFIG_*`、`PARAMETER_SET_*`及
`STRATEGY_INPUT_*` errors。

## Acceptance criteria

- [ ] Dry-run精確列出inherited與new Experiments且不建立artifacts。
- [ ] Parent successful Run完全不變；filesystem write spy無Parent-targeted write，bounded metadata／inventory
      snapshot一致。
- [ ] Child只包含new Experiments，沒有Parent Symbol artifacts。
- [ ] Existing Config prefix任何mutation都在Desktop access前被拒絕。
- [ ] New Inputs依Parent Base及current matching schema驗證。
- [ ] V4 standalone／extension strict schemas及v2／v3 compatibility完整。
- [ ] Extension child中斷後可用existing `strategy resume`完成。
- [ ] Resume在Parent directory unavailable且Parent loader被設定為fail-fast時仍成功。
- [ ] Chained Extension可沿lineage正確識別下一個new suffix。
- [ ] Run／Extend formal paths共用同一durable execution lifecycle，沒有複製orchestration。
- [ ] Fault tests證明initialization／manifest／finalization crash不破壞Parent。
- [ ] Node 22／24 full unit、lint、pack dry-run及controlled live gate通過。

## Tasks

| ID | Task | Status | Depends on |
| --- | --- | --- | --- |
| [TASK-001](./TASK-001-artifact-v4-lineage-contract.md) | Artifact v4 and Lineage Contract | `done` | Artifact v3 |
| [TASK-002](./TASK-002-extension-config-planner.md) | Append-only Config Diff and Planning | `done` | TASK-001 |
| [TASK-003](./TASK-003-extension-run-integration.md) | Extension CLI, Durable Execution and Resume | `done` | TASK-002 |
| [TASK-004](./TASK-004-regression-live-delivery.md) | Regression, Live Acceptance and Delivery | `in_progress` | TASK-003 |

Detailed decisions見[`DECISIONS.md`](./DECISIONS.md)，module design見[`LLD.md`](./LLD.md)，automated
validation evidence見[`DELIVERY_EVIDENCE.md`](./DELIVERY_EVIDENCE.md)。
