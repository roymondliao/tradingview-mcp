# Strategy Run Schema Naming — Low-Level Design

Status: `implemented`

## 1. Current behavior

Formal Strategy Run目前共用：

```js
export const STRATEGY_RUN_ARTIFACT_VERSION = 2;
```

`run.json`、`experiment.json`與Experiment `manifest.json` root皆輸出`schema_version: 2`。Validated Run Config保存在`run.json.requested`，其中仍有`schema_version: 1`。兩個欄位名稱相同但contract不同。

Current read path只接受artifact v2；validator透過一個`assertVersion()`處理三種formal artifacts。Resume updates也固定使用current artifact constant，因此加入v2 backward compatibility後，writer不可再只依賴global current version。

## 2. Target JSON contracts

### 2.1 `run.json` v3

```json
{
  "artifact_schema_version": 3,
  "run_id": "obv-v3-...",
  "status": "running",
  "requested": {
    "config_schema_version": 1,
    "run": {},
    "strategy": {},
    "target": {},
    "backtest": {},
    "experiments": {},
    "output": {}
  },
  "config": {},
  "source_sha256": "...",
  "candidate_schema_fingerprint": "...",
  "resolved": {},
  "started_at": 0,
  "started_at_iso": "...",
  "updated_at": 0,
  "updated_at_iso": "...",
  "summary": {},
  "experiments": [],
  "error": null
}
```

其他v2 fields與semantics保持不變。

### 2.2 `experiment.json` v3

```json
{
  "artifact_schema_version": 3,
  "run_id": "...",
  "experiment_id": "sha256:...",
  "parameter_set": {},
  "strategy": {},
  "target": {},
  "base_inputs_fingerprint": {},
  "inputs_fingerprint": {},
  "effective_inputs": [],
  "started_at": 0,
  "started_at_iso": "..."
}
```

### 2.3 Experiment `manifest.json` v3

```json
{
  "artifact_schema_version": 3,
  "run_id": "...",
  "experiment_id": "sha256:...",
  "parameter_set_name": "baseline",
  "status": "running"
}
```

其餘manifest fields與semantics保持不變。Optional `schema_versions` map不因root naming改變。

## 3. Version model

Core constants分離current write version與readable legacy version：

```js
export const STRATEGY_RUN_ARTIFACT_VERSION = 3;
export const STRATEGY_RUN_LEGACY_ARTIFACT_VERSION = 2;
export const STRATEGY_RUN_ARTIFACT_FAMILIES = Object.freeze(['v2', 'v3']);
```

實際命名可依現有module conventions微調，但不得只保留一個constant後在各處寫magic number `2`。

Internal family descriptor至少包含：

```js
{
  family: 'v2' | 'v3',
  artifact_version: 2 | 3,
  artifact_version_field: 'schema_version' | 'artifact_schema_version',
  requested_config_version_field: 'schema_version' | 'config_schema_version'
}
```

Descriptor只供validator／serializer dispatch，不寫入artifact。

## 4. Detection and validation

### 4.1 Root detection

在完整strict validation前執行bounded discriminator detection：

```text
has own schema_version only
  + value 2 → v2
  + other value → RUN_RESUME_VERSION_UNSUPPORTED

has own artifact_schema_version only
  + value 3 → v3
  + other value → RUN_RESUME_VERSION_UNSUPPORTED

both fields present → RUN_RESUME_ARTIFACT_INVALID
neither field present → RUN_RESUME_ARTIFACT_INVALID
```

不得使用truthiness、fallback chain或`fieldA || fieldB`，避免zero／null／dual-field ambiguity。

### 4.2 Strict allowed fields

為v2與v3維持獨立allowed-field sets，或由immutable base fields加family-specific version field組成。Validation後domain value可保留原shape，或normalize後附帶non-enumerable／out-of-band family metadata；不得把internal descriptor意外serialize。

### 4.3 Requested Config version

`run.json` strict validation依artifact family要求exact field：

```text
v2 → requested.schema_version === 1
v3 → requested.config_schema_version === 1
```

兩者不得同時存在。Config version unknown時回傳artifact invalid，因外層artifact version本身已可讀，但其中persisted request contract無法安全解讀。

### 4.4 Tree consistency

`openDurableRunStore()`讀取並validate `run.json`後取得family。後續Experiment metadata／manifest readers必須收到expected family，不可各自接受任意supported family後混用。

```text
load run.json → family
  → load watchlist.json (unchanged independent contract)
  → load experiment.json(expected family)
  → load manifest.json(expected family)
```

Mismatch使用`RUN_RESUME_ARTIFACT_INVALID`，message指出path、expected與observed family。

## 5. Write behavior

### 5.1 New Run

`strategy run`永遠使用current v3 serializer：

- Initial `run.json` root寫`artifact_schema_version: 3`。
- Normalized requested projection把`schema_version`改投影為`config_schema_version`。
- Durable Experiment建立v3 `experiment.json`與v3 `manifest.json`。

### 5.2 Resume

Resume loader將family傳入所有會persist state的service：

```text
resume load result
  → run transition serializer
  → durable experiment create/open
  → manifest transition serializer
  → final run serializer
```

V2 serializer輸出原有shape；v3 serializer輸出新shape。Domain transition functions不得默認把v2 object spread後加上v3 field，避免同時留下兩個version keys。

### 5.3 No migration

不提供：

- CLI migration command。
- Lazy per-file upgrade。
- Resume前directory rewrite。
- v2 artifact mutation成v3。

若未來需要停止v2 writer compatibility，應先提供獨立、可驗證且可recover的whole-run migration設計。

## 6. Module impact

### `src/core/strategy-run-state.js`

- Current v3與legacy v2 constants。
- Family discriminator。
- v2／v3 strict validators。
- Family-aware transition serialization或shape-preserving transition helpers。
- Requested Config version validation。

### `src/core/strategy-run-config.js`

- User-facing Config v1 validation不變。
- 保留normalized internal request source value。
- 不在此module假裝raw Config key已改名；artifact projection由Run artifact builder負責，或新增明確projection helper。

### `src/core/strategy-run.js`

- Initial artifact使用v3 root field。
- `requested`投影使用`config_schema_version`。
- 將v3 family傳入durable Experiment services。

### `src/core/strategy-durable-experiment.js`

- New Run依family建立Experiment／manifest。
- Resume新增missing Experiment時繼承existing Run family。
- Manifest updates維持existing family。

### `src/core/strategy-run-artifacts.js`

- Bounded read後dispatch family validator。
- Store或load result保留Run family。
- Read methods對Experiment files執行expected-family check。

### `src/core/strategy-resume.js`

- 使用loaded Run family，不使用current writer default。
- 所有Run／Experiment persist paths傳遞family。
- Final response若公開schema metadata，使用明確artifact命名；不新增無需求的response field。

### Tests and fixtures

- `tests/strategy_run_state.test.js`
- `tests/strategy_run_artifacts.test.js`
- `tests/strategy_run.test.js`
- `tests/strategy_resume.test.js`
- `tests/strategy_durable_fault_matrix.test.js`
- `tests/helpers/strategy_resume_fixture.js`
- Scripts或benchmarks內直接建立formal artifact的fixtures。

Exact impact以implementation前`rg`結果為準；不得只更新production writer而遺漏benchmark／fault fixtures。

## 7. Error behavior

| Condition | Code | Phase |
| --- | --- | --- |
| Missing Run Directory／`run.json` | `RUN_RESUME_NOT_FOUND` | `resume_load` |
| Artifact v1或unknown future version | `RUN_RESUME_VERSION_UNSUPPORTED` | `resume_validation` |
| Both version fields present | `RUN_RESUME_ARTIFACT_INVALID` | `resume_validation` |
| Recognized family with wrong field shape | `RUN_RESUME_ARTIFACT_INVALID` | `resume_validation` |
| Experiment／manifest family differs fromRun | `RUN_RESUME_ARTIFACT_INVALID` | `resume_validation` |
| Unsupported persisted Config version | `RUN_RESUME_ARTIFACT_INVALID` | `resume_validation` |

所有上述failure必須在TradingView connection／mutation前發生。

## 8. Test matrix

### Pure validation

- Valid v2 Run／Experiment／manifest。
- Valid v3 Run／Experiment／manifest。
- V2 root paired withv3 requested field and inverse。
- Both root fields、missing root fields、null、string、fractional及unknown integer versions。
- Unknown fields仍由strict validator拒絕。

### Store and Resume

- Complete v2 tree load／Resume／persist remains v2。
- Complete v3 tree load／Resume／persist remains v3。
- Every v2/v3 mixed tree permutation fails before mutation。
- Missing Experiment created during v2 Resume is v2；during v3 Resume is v3。
- Atomic replacement fault leaves prior same-family file readable。

### New Run

- Config v1 creates v3 formal artifacts。
- All Parameter Sets receivev3 Experiment／manifest files。
- No new formal artifact contains ambiguous legacy root key。
- `run.json.requested` contains exactly oneConfig version field。

### Non-regression

- Dry-run output and read-only behavior。
- Trading Export v1 artifact contract。
- Watchlist Symbol validation contract。
- Retry、summary、identity、lease、signal and restore behaviors。
- Existing v2 fixture hashes only change where fixture purpose is new-write behavior。

## 9. Documentation updates during implementation

Implementation完成時需同步：

- Current user／operator manual中formal artifact examples。
- Durable Export Recovery文件加入v3 follow-up reference，不回寫歷史decision使其看似原本就是v3。
- Run Config文件明確區分input `schema_version`與persisted `config_schema_version`。
- Release notes記錄new-write v3與v2 Resume compatibility。
