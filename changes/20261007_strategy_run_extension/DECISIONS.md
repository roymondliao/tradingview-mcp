# Strategy Run Extension — Design Decisions

Status: `proposed`

## Decision register

| ID | Topic | Status | Decision |
| --- | --- | --- | --- |
| D-001 | Public command | `proposed` | 新增`strategy extend --run-directory --config [--dry-run]`，不把Extension藏在Resume。 |
| D-002 | Parent mutability | `proposed` | Parent必須`succeeded`且保持immutable；Extension建立new child Run Directory。 |
| D-003 | Config semantics | `proposed` | Config是完整desired sequence；existing lineage必須exact prefix，只有suffix是new。 |
| D-004 | Artifact contract | `proposed` | New formal writes升級v4，加入`run_kind`及strict extension lineage metadata。 |
| D-005 | Child contents | `proposed` | Child只保存new Experiments；copy bounded frozen evidence，不copy Parent Symbol artifacts。 |
| D-006 | Index semantics | `proposed` | Execution維持child-local index；lineage metadata保存config／lineage index mapping。 |
| D-007 | Watchlist | `proposed` | Copy Parent frozen membership；不recapture，execution前重新validate same ordered Symbols。 |
| D-008 | Base Inputs | `proposed` | New effective Inputs以Parent persisted Base為authority，不以current Pane值為baseline。 |
| D-009 | Resume | `proposed` | Child self-contained並沿用`strategy resume`；Resume不依賴Parent directory或Config。 |
| D-010 | Chaining | `proposed` | Successful Extension可作下一Parent；ancestor chain組成完整inherited prefix。 |
| D-011 | Shared lifecycle | `proposed` | Run／Extend preflight adapters產生共同execution spec，formal paths共用durable lifecycle。 |
| D-012 | Pine identity | `proposed` | Parent／Extension必須same saved Strategy + normalized source hash；local source path可不同。 |
| D-013 | Lineage bounds | `proposed` | Extend traversal固定depth 64、4096 Experiments及64 MiB cumulative JSON；Resume不traverse。 |

## D-001 Public command

Decision:

```bash
tv strategy extend --run-directory <parent> --config <extended-config> [--dry-run]
```

Rationale:

- `resume`只恢復同一Run已persist的unfinished work，不能讀取new Config或擴張plan。
- Extension同時需要Parent與new Config，獨立verb最清楚。
- `strategy run --extend`的boolean無法表達Parent target；`--extend-from`仍會讓run/create與lineage
  semantics混在同一handler。

Rejected alternatives:

- `strategy resume --config`：破壞frozen resume contract，成功Run目前也必須immutable。
- `strategy run --config ... --extend-from ...`：可實作但public intent較不明確，錯誤與help也較難區分。
- 自動偵測Config與existing Run差異：可能把Run ID collision誤當Extension授權。

## D-002 Immutable Parent and new child

Decision:

- Parent必須完成且`status === succeeded`。
- Extension exclusive-create sibling child directory。
- Parent所有files在operation前後保持不變；測試以filesystem write spies加bounded metadata／inventory
  snapshots證明，不為此重讀或hash大型Trade payloads。
- Failed/running Parent必須先使用`strategy resume`完成。

Rationale:

重新開啟成功Run需要修改terminal state、requested config、plans與summaries，會破壞既有durable
immutability及讓crash留下half-extended tree。New child將failure boundary限制在Extension本身。

Rejected alternatives:

- In-place append Parent `planned_experiments`：multi-file update無法整個tree atomic commit。
- Copy Parent complete tree後再append：複製大量trading artifacts、形成兩份authority。

Failure behavior:

- Parent不是succeeded時回傳`RUN_EXTENSION_PARENT_NOT_SUCCEEDED`。
- Child collision回傳existing `RUN_OUTPUT_EXISTS`。

## D-003 Full Config and append-only prefix

Decision:

- `--config`包含完整desired sequence，而不是只包含delta。
- Ancestor Parameter Sets形成authoritative inherited prefix。
- Existing prefix逐項exact match；remaining non-empty suffix是new Experiments。

Rationale:

User可以持續維護同一份Config並看見完整實驗歷史。Exact prefix rule消除rename、reorder、insert及
silent replacement的歧義。

Rejected alternatives:

- Config只列new suffix：無法證明User理解／保留existing lineage。
- 只按name做set difference：reorder或same-name parameter mutation可能被忽略。
- Changed existing item視為new revision：名稱不變會讓analysis及artifact paths ambiguous。

## D-004 Artifact v4

Decision:

- New `strategy run`與`strategy extend`都寫formal artifact v4。
- V4 `run.json`新增required `run_kind: standalone|extension`。
- Extension另有required strict `extension` object；standalone不得有該object。
- V4 `experiment.json`／`manifest.json`使用相同root artifact version，其他domain fields保持相容。
- Readers繼續支援v2／v3／v4；v2／v3 Resume保持原family writes。

Rationale:

Strict artifact v3不允許新增root fields。使用v4讓lineage成為formal auditable contract，避免靠命名或
optional sidecar猜測Run kind。

Rejected alternatives:

- 在v3直接加入optional fields：同一version產生兩個schema。
- `lineage.json` sidecar而run.json不知道kind：discoverability差且多一份required state source。
- 只讓Extension寫v4、standalone繼續v3：current writers分裂，fixtures與services更難維護。

## D-005 Child contents

Decision:

Child保存：

- Own v4 `run.json`。
- Copied Parent frozen `watchlist.json` membership／snapshot，child-owned validation state。
- Only new Experiment metadata、manifests及Symbol artifacts。
- Parent Base Inputs、source/schema hashes、stable identity及lineage fingerprints。

Child不保存：

- Parent Experiment directories。
- Parent Symbol artifacts。
- Copied Parent summaries或bounded Experiment views。

Rationale:

Child必須能獨立Resume，但不需要複製large successful evidence。Lineage aggregation應由reader動態完成。

## D-006 Local and lineage indexes

Decision:

- Child execution plan維持local `parameter_set.index = 0..N-1`。
- `extension.new_parameter_sets[]`保存`config_index`及`run_index`。
- `lineage_index`等於full Config index，供aggregation排序。
- Experiment IDs仍只需在Run內唯一；new names在ancestor chain唯一。

Rationale:

Current execution／manifest code廣泛以array position作index。保留local index可縮小變更面；lineage
metadata明確提供global ordering，不用把global index滲透每個transition。

## D-007 Frozen Watchlist reuse

Decision:

- Child copy Parent exact ordered Symbols、Snapshot ID及ordered fingerprint。
- 不重新讀Account Watchlist membership。
- Child建立後以current TradingView逐筆validate same Symbols並persist child validation evidence。

Rationale:

重新capture membership會讓Parent與Extension比較不同Symbol universe；完全跳過validation又可能直到
Experiment中途才發現Symbol已不可用。

## D-008 Parent Base Inputs

Decision:

- New plan以Parent persisted Base Inputs及fingerprint為baseline。
- Current runtime schema必須匹配Parent Candidate schema fingerprint。
- Execution前受控apply／readback Parent Base；完成後restore同一Base。
- Current incidental Inputs不得成為new baseline。

Rationale:

不同baseline會讓same requested overrides產生不同effective configurations，破壞lineage比較。

## D-009 Self-contained Resume

Decision:

- Fully initialized child包含Resume所需source path/hash、Watchlist、Base、new plans及identity。
- `strategy resume --run-directory <child>`只讀child。
- Parent path及extended Config只在Extension creation／future lineage aggregation需要。
- Lineage fingerprints在Resume中只作provenance／shape evidence，不重新載入Parent計算。

Rationale:

Durable Resume不應因Parent directory被archive／move或Config改動而失效。Parent fingerprint保留audit，
但不是child recovery runtime dependency。

## D-010 Chained extensions

Decision:

- Succeeded Extension可作Parent。
- Planner安全讀取ancestor chain，detect cycles、duplicate IDs及fingerprint mismatch。
- Full Config prefix必須等於root到direct Parent的ordered Parameter Sets。
- 第一版允許lineage branches，不scan siblings。

Rationale:

Repeated analysis→append是主要workflow。禁止branches需要output-root registry或全目錄掃描，超出local
Parent contract且有TOCTOU問題。

## D-011 Shared durable lifecycle

Decision:

- Standalone Run與Extension各自保留domain-specific preflight／planning adapter。
- 兩者產生同一個bounded `DurableRunExecutionSpec`。
- Lease、Chart Session、frozen Watchlist validation、Experiment execution、Base restore、finalization、
  error mapping及response construction由共同lifecycle service執行。
- Dry-run呼叫相同preflight／planning functions，但不得進入formal lifecycle。

Rationale:

`strategy run`與`strategy extend`差異集中在Parent diff、Base來源及child metadata。複製現有
`runStrategyAutomation()` orchestration會讓signal、restore、atomic finalization及progress semantics分岔。

Required tests:

- Run／Extend以spy證明呼叫同一formal lifecycle service。
- Dry-run不取得lease、不建立store、不開啟mutation session。
- Shared lifecycle failure matrix對兩個callers產生相同durability guarantees。

## D-012 Pine source identity

Decision:

- Parent與extended Config的`saved_name`必須相同。
- 使用既有`normalizedPineSourceSha256()`計算的Pine source SHA-256必須相同；不同hash必須建立
  new standalone Run。
- Local canonical source path不是Strategy identity，可以不同。
- Child保存new Config解析出的absolute source path，Resume只使用child persisted path/hash。

Rationale:

Extension比較的是相同Strategy source的不同Inputs。Filesystem location是local recovery locator，不是
Pine semantic identity；要求same path會不必要地拒絕identical source relocation。

## D-013 Lineage bounds and fingerprints

Decision:

```text
STRATEGY_RUN_LINEAGE_MAX_DEPTH = 64
STRATEGY_RUN_LINEAGE_MAX_EXPERIMENTS = 4096
STRATEGY_RUN_LINEAGE_MAX_JSON_BYTES = 64 * 1024 * 1024
STRATEGY_RUN_LINEAGE_FINGERPRINT_VERSION = 1
```

- Bounds只套用Extend／aggregation ancestor traversal，不套用child Resume。
- 超限回傳`RUN_EXTENSION_LINEAGE_LIMIT_EXCEEDED` before Desktop access。
- Parent Run fingerprint由persisted stable projection計算，不讀current runtime IDs。
- Fingerprint不hash full Report／Trades／Reconciliation payloads。
- Parent planned Experiment IDs不進入stable projection，因current ID schema間接包含runtime `entity_id`；
  改用ordered name、requested-input fingerprint、effective-input fingerprint及Base fingerprint。
- Lineage fingerprint由version、direct Parent Run fingerprint、Parent lineage fingerprint、cumulative
  Parameter Set fingerprint及counts組成。

Rationale:

Chain A→B→…→N是合法workflow；`lineage_depth`以Extension edge計算（A=0、B=1、C=2），但必須有
memory／I/O upper bound及versioned canonical hash payload。
Resume已具備完整child artifacts，不應承擔ancestor traversal成本或availability dependency。
