# Strategy Automation Run LLD

Status: `planned`

## Purpose

本文件定義[`Strategy Automation Run`](./README.md)的CLI-first implementation architecture。目標是以一份versioned JSON config，依exact names解析TradingView Layout、Saved Strategy與Watchlist，先完成read-only dry-run validation，再於正式run自動同步local Pine source、refresh指定Pane Strategy Instance、建立完整Watchlist Snapshot，依序執行多組Parameter Sets並重用既有Strategy Trading export能力。

CLI是主要產品入口；所有行為實作於可注入、可單元測試的Core modules。MCP或shell後續可直接呼叫相同Core functions，不透過CLI subprocess組合commands。

## Scope

### In scope

- `pine check`保留sanitized Compiler Input Variables，建立hybrid Candidate Input Schema。
- `study inputs get`回傳name／type／group／default／constraints與current value。
- `study inputs set`支援互斥的`--inputs`與`--inputs-by-name`，採all-or-nothing validation。
- `watchlist snapshot --name`取得完整、ordered、stable的named Watchlist Snapshot。
- Versioned Run Config、generated／explicit Run ID、config-relative paths與exact-name resolution。
- `strategy run --config ... --dry-run`完整read-only preflight與aggregated errors。
- Account Saved Strategy automatic create／update／reuse與safe Pane refresh。
- Explicit Parameter Sets、Base Inputs、fresh Strategy recalculation與existing Watchlist export integration。
- Canonical run／snapshot／experiment metadata與existing JSON／JSONL／CSV Trade formats。

### Out of scope

- Durable per-Symbol checkpoint、automatic retry／backoff、resume與crash recovery；由後續Durable Export change處理。
- 1,974-Symbol容量認證以外的parallel workers或multi-Pane execution。
- Cartesian parameter grid generation或optimizer。
- Strategy Properties automation，例如Initial Capital／Commission；本次Parameter Sets只涵蓋Pine `input.*()`。
- Public／Protected／Invite-only Pine publish。
- Database import與analysis；屬於`trading-cli`。
- Desktop compatibility Gate；屬於`changes/20260903_desktop_version_compatibility`。
- High-level `strategy_run` MCP tool與通用local-only E2E runner；Core seams需保留供後續功能重用。

`recovery`不屬於V1 Run Config schema，避免接受但不執行的設定。既有[`RUN_CONFIGURATION.md`](./RUN_CONFIGURATION.md)中的recovery候選必須在TASK-004移除並明確連到future Durable Export change。

## Architecture principles

1. **CLI first**：public commands、arguments、JSON responses與exit codes先固定，再由Core支援。
2. **Config describes intent**：User填寫names與parameter titles；TradingView IDs只存在於resolved output。
3. **Dry-run is read-only**：所有可由filesystem、compiler、Account與Desktop reads偵測的錯誤在mutation前聚合回傳。
4. **Formal run revalidates**：dry-run不是cache或authorization；正式run在mutation前重新解析全部resources與schemas。
5. **Core owns orchestration**：high-level command不啟動`pine`、`study`、`watchlist`或`strategy trading-export`CLI subprocess。
6. **Exact identity**：names必須exact且唯一；解析後固定target、Layout、Pane、Watchlist、script、version與entity identities。
7. **Candidate then runtime**：local／compiler Candidate Input Schema先驗證Config；update後以new Runtime Schema再次驗證。
8. **Safe refresh**：old Pane Instance在new latest Instance完成version、Inputs與Report驗證前不可移除。
9. **No state leakage**：每個Parameter Set都由同一Base Inputs建立，不從上一組繼承。
10. **Reuse verified trading flow**：Report、Trades、snapshot與reconciliation重用`strategy-trading.js`，不複製runtime expressions。

## Target CLI contract

### Pine compile metadata

```bash
npm run tv -- pine check --file ./strategy.pine
```

保留既有compile semantics，新增bounded `input_variables`：

```json
{
  "success": true,
  "compiled": true,
  "input_variables": [
    { "variable_name": "wobvMaLen", "inferred_type": "int" }
  ],
  "input_schema": {
    "source": "compiler_plus_local_scanner",
    "input_count": 16,
    "fingerprint": "sha256:...",
    "inputs": []
  }
}
```

`input_variables`直接來自sanitized compiler symbol metadata；`input_schema`由hybrid provider建立。Compile failure仍回傳errors，且不得將不完整schema標為available。

### Study Inputs

```bash
npm run tv -- study inputs get <entity-id> [pane context]
npm run tv -- study inputs set <entity-id> --inputs '<json-by-id>' [pane context]
npm run tv -- study inputs set <entity-id> --inputs-by-name '<json-by-name>' [pane context]
```

- Get合併`getInputsInfo()`與`getInputValues()`。
- `--inputs`與`--inputs-by-name`互斥且皆為non-empty JSON object。
- Mutation前驗證全部selectors、types與constraints；任一錯誤時不呼叫`setInputValues()`。
- Set readback回傳resolved ID／name、before／requested／actual values與complete fingerprint。
- Strategy set只回傳`report_state: recalculating`；不在Study module等待Report。

### Watchlist Snapshot

```bash
npm run tv -- watchlist snapshot --name "stock_list"
npm run tv -- watchlist snapshot --name "stock_list" --output ./stock-list.json [--force]
```

- Exact-name Account resolution。
- Same-origin Account detail source取得完整ordered Symbols。
- 至少兩次相同count、modified與fingerprint才成功。
- DOM rows只作diagnostic；`watchlist get`明確回傳`complete: false`。
- Output固定JSON且atomic write；existing file除非`--force`否則拒絕。

### Strategy Automation Run

```bash
npm run tv -- strategy run --config ./run-config.json --dry-run
npm run tv -- strategy run --config ./run-config.json
```

- `--config`必填。
- `--dry-run`不得Account save、Pane mutation、Symbol／Timeframe／Inputs mutation或artifact publish。
- V1不提供CLI flags覆蓋config fields。
- Valid dry-run exit `0`；任一blocking validation error回傳`success: false`、`valid: false`與aggregated `errors[]`，exit `1`。CDP connection failure維持exit `2`。
- 正式run成功stdout只回傳bounded summary與output path；完整data寫入artifacts。

## Run Config schema v1

```json
{
  "schema_version": 1,
  "run": {
    "run_id": "obv-v3-baseline-01",
    "description": "OBV v3 baseline"
  },
  "strategy": {
    "file": "../strategies/obv-v3.pine",
    "saved_name": "obv-v3"
  },
  "target": {
    "layout": { "name": "dev" },
    "pane_index": 0,
    "watchlist": { "name": "stock_list" }
  },
  "backtest": {
    "timeframe": "1D"
  },
  "experiments": {
    "parameter_sets": [
      { "name": "baseline", "inputs": {} },
      {
        "name": "fast",
        "inputs": {
          "wOBV 平滑 MA 週期": 5,
          "趨勢 SMA 週期": 10
        }
      }
    ]
  },
  "output": {
    "directory": "../output",
    "format": "csv"
  }
}
```

- `run_id`選填；default為`<strategy-slug>-<UTC timestamp>-<8-hex>`。
- Relative paths以config directory解析。
- Unknown fields是schema error，避免拼字錯誤被忽略。
- Layout、Saved Strategy、Watchlist與Input title都採exact、case-sensitive names。
- `pane_index`與`backtest.timeframe`必填。
- Parameter Set name必填、path-safe且在同一run唯一；至少一組。
- Output format沿用`json|jsonl|csv`，只控制Trading Data artifact。

## Dependency architecture

```text
src/cli/commands/strategy.js
  └── strategy run command / CLI validation
                │
                ▼
src/core/strategy-run.js                    Application Service
  ├── strategy-run-config.js                Pure config / paths / Run ID
  ├── strategy-run-resolver.js              Name -> runtime identities
  ├── pine-input-schema.js                  Candidate schema
  ├── strategy-sync.js                      Account + Pane sync
  ├── strategy-parameter-sets.js            Plan / apply / restore
  ├── watchlist.js                           Complete named Snapshot
  ├── studies.js                             Runtime Input Catalog / mutation
  ├── strategy-runtime.js                    Fresh calculation
  ├── strategy-trading.js                    Existing verified export
  └── artifacts.js                           Existing atomic primitives
                │
                ▼
pine.js / pane.js / tab.js / layout-identity.js / connection.js
```

Existing CLI／MCP surfaces call the same extended `pine.js`、`studies.js`與`watchlist.js`functions。No module imports CLI handlers。

## Module design

### Extend `src/core/pine.js`

- Export shared `normalizePineSource()` and normalized source SHA-256 helper。
- Extend compiler adapter to sanitize`variables2` Input symbols。
- Compose Compiler Input Variables with`pine-input-schema.js`。
- Preserve current compile errors／warnings contract and avoid raw compiler payload leakage。

### New `src/core/pine-input-schema.js`

Pure functions：

```js
extractCandidateInputSchema({ source, compiler_inputs })
compareInputSchemas({ current, candidate })
validateCandidateInputSchema(schema)
```

- Token-aware declaration scanner, generic balanced call／argument parsing。
- Static literal title required；bounded literal evaluator。
- Type registry而非per-type parser。
- Output沒有runtime `in_x`。
- Deterministic schema／declaration fingerprints。

### Extend `src/core/studies.js`

```js
getStudyInputCatalog({ entity_id })
resolveStudyInputOverrides({ catalog, by_id, by_name })
setStudyInputs({ entity_id, inputs, inputs_by_name })
fingerprintStudyInputs(inputs)
```

- Input Catalog合併info與values並過濾internal／hidden items。
- Name mapping exact且unique。
- Validation與mutation分離，確保all-or-nothing。
- Time values保留milliseconds與ISO companions。

### Extend `src/core/watchlist.js`

```js
resolveWatchlistByName({ name })
readWatchlistDetail({ watchlist_id })
captureNamedWatchlistSnapshot({ name })
```

- Account list與detail response adapters分離。
- Stable two-read bounded loop。
- Validate declared／returned／unique／invalid counts。
- Snapshot SHA-256由ID、name、modified與ordered Symbols建立。
- 現有`captureActiveWatchlistSnapshot()`保留compatibility，但new run不得使用DOM source。

### New `src/core/strategy-run-config.js`

Pure／filesystem-bounded responsibilities：

- Read and strict-validateJSON schema version 1。
- Resolve config-relative paths，validate Pine readability與output collision。
- Validate／generatepath-safeRun ID與Parameter Set names。
- Produce normalized requested specification與config content hash。

不得連接CDP或執行TradingView mutation。

### New `src/core/strategy-run-resolver.js`

```js
resolveStrategyRunResources({ requested })
assertResolvedStrategyRunResources(resolved)
```

- `tab list`中以exact Layout name找唯一open Chart Tab。
- 以required Pane index取得`pane_id`與original Symbol／Timeframe。
- Account Watchlist與Saved Strategy exact-name resolution。
- Pane Strategy Instance以resolved `script_id`比對，不只依display title。
- Resolved identity在每個mutation phase read back ownership。

Zero／multiple matches使用stable errors，不猜active或first resource。

### New `src/core/strategy-sync.js`

```js
planStrategySync({ requested, resolved, candidate_schema })
executeStrategySync(plan)
```

Account plan：missing=`create`、normalized hash equal=`reuse`、different=`update`。Mutation前server compile必须成功；update後read back same `script_id`、new version與local normalized hash。

Pane plan：missing=`add_latest`、matching latest=`reuse`、single stale=`refresh`、multiple same script=`ambiguous error`。

`matching latest`必須同時具有exact `script_id`與可讀取且等於Account latest的Pane version；version unavailable是blocking capability error，不可猜測`reuse`或`refresh`。Pane inventory優先使用metadata `scriptIdPart`，fallback只能從definition ID嚴格解析完整`USER;...`identity，不使用substring matching。

Refresh保留old，add latest並驗證new version／Runtime Schema／Base Inputs／fresh Report後才remove old。Failure cleanup只移除transaction建立且ownership已確認的new Instance。Account已latest但Pane stale可由下次run只重試refresh。

Input schema migration以exact name：compatible existing values preserve；added使用new Runtime default；removed drop並記錄；type／constraint不相容使用new default並warning。Parameter Sets仍必須全部通過Candidate與Runtime validation。

### New `src/core/strategy-parameter-sets.js`

Pure planning：

```js
planParameterSets({ base_catalog, candidate_schema, parameter_sets })
```

Runtime execution：

```js
withParameterSet({ plan, context, entity_id }, operation)
restoreBaseInputs({ base, context, entity_id })
```

- 每組Effective Inputs=`captured Base + current overrides`。
- Effective Inputs只在完整Runtime Catalog可用時建立；stdout只需回傳requested／resolved overrides與完整fingerprint，不輸出整份catalog。
- Apply前讀取Report state；Study Core mutation/readback後，以new Input fingerprint呼叫Strategy Runtime等待fresh stable Report。
- 即使Report metrics相同，也以Inputs fingerprint與calculation lifecycle證明freshness。
- 每組完成才執行下一組；finally恢復Base Inputs並read back。

### New `src/core/strategy-run.js`

```js
dryRunStrategyAutomation({ config_path })
runStrategyAutomation({ config_path })
```

Dry-run聚合static／filesystem／compiler／resource／watchlist／schema／parameter errors；各independent check應儘量繼續，dependent phase在prerequisite失敗時標為`blocked`而不是製造次生errors。

Formal run重做preflight後：

```text
load + validate config
  -> resolve names and immutable context
  -> compile + Candidate Input Schema
  -> capture complete named Watchlist Snapshot
  -> ensure no blocking validation errors
  -> execute Account / Pane Strategy Sync
  -> read back new Runtime Schema and resolved entity_id
  -> capture Base Inputs
  -> for each Parameter Set
       -> apply effective Inputs
       -> wait fresh stable Report
       -> export same immutable Watchlist Snapshot
       -> record Experiment result
  -> finally restore Base Inputs and Chart context
  -> publish bounded run summary and canonical artifacts
```

`strategy-trading.js`需提供接受caller-supplied Snapshot與artifact namespace的internal function，避免run重新讀取Active DOM Watchlist或啟動CLI subprocess。Existing public `strategy trading-export --watchlist active`維持compatibility。

## Artifact contract

本change提供非durable的verified run artifact tree：

```text
<output>/<run-id>/
├── run.json
├── watchlist.json
└── experiments/
    └── <parameter-set-name>/
        ├── experiment.json
        ├── manifest.json
        └── symbols/
            └── <safe-symbol>/
                ├── report.json
                ├── trades.json | trades.jsonl | trades.csv
                └── reconciliation.json
```

- `run.json`保存requested config、config／source／schema hashes與resolved identities。
- `watchlist.json`保存完整immutable ordered Snapshot與completeness evidence。
- `experiment.json`保存Parameter Set requested names、resolved IDs、Base／Effective Inputs、fingerprint、Strategy revision與timestamps。
- Existing Trading artifact schemas與five-metric reconciliation不改變。
- Run ID collision拒絕覆寫；本command不提供`--force`。
- Durable per-Symbol publication／progress不在本change；process中斷時staging cleanup與可恢復性由future change補足，不宣稱resume support。

## Dry-run response

```json
{
  "success": true,
  "valid": true,
  "run": {},
  "strategy_sync": {
    "account_action": "update",
    "pane_action": "refresh"
  },
  "resources": {},
  "watchlist": {
    "complete": true,
    "count": 448,
    "snapshot_id": "sha256:..."
  },
  "input_schema_changes": {},
  "parameter_sets": [],
  "warnings": [],
  "errors": []
}
```

Large Symbol arrays不在dry-run stdout完整展開；回傳counts、fingerprint與bounded first／last samples。正式artifact保存完整清單。

## Error taxonomy

| Code family | Examples |
| --- | --- |
| Config | `RUN_CONFIG_INVALID`, `RUN_ID_INVALID`, `RUN_OUTPUT_EXISTS` |
| Layout／Pane | `TARGET_LAYOUT_NOT_OPEN`, `TARGET_LAYOUT_AMBIGUOUS`, `PANE_INDEX_INVALID`, `PANE_CONTEXT_CHANGED` |
| Watchlist | `WATCHLIST_NOT_FOUND`, `WATCHLIST_AMBIGUOUS`, `WATCHLIST_INCOMPLETE`, `WATCHLIST_SNAPSHOT_UNSTABLE`, `WATCHLIST_SNAPSHOT_UNSUPPORTED` |
| Account Strategy | `STRATEGY_NAME_AMBIGUOUS`, `ACCOUNT_STRATEGY_VERSION_UNAVAILABLE`, `STRATEGY_SOURCE_READBACK_MISMATCH`, `STRATEGY_VERSION_READBACK_MISMATCH` |
| Pane Strategy | `STRATEGY_INSTANCE_AMBIGUOUS`, `PANE_STRATEGY_VERSION_UNAVAILABLE`, `STRATEGY_REFRESH_FAILED`, `STRATEGY_REFRESH_CLEANUP_FAILED` |
| Candidate Schema | `PINE_INPUT_STATIC_TITLE_REQUIRED`, `PINE_INPUT_SCHEMA_UNRESOLVED`, `PINE_INPUT_TYPE_MISMATCH` |
| Study Inputs | `STUDY_INPUT_SELECTOR_CONFLICT`, `STUDY_INPUT_NOT_FOUND`, `STUDY_INPUT_NAME_AMBIGUOUS`, `STUDY_INPUT_VALUE_INVALID` |
| Parameter Sets | `PARAMETER_SET_NAME_DUPLICATE`, `PARAMETER_SET_INPUT_NOT_FOUND`, `PARAMETER_SET_INPUT_VALUE_INVALID`, `RUNTIME_INPUT_CATALOG_EMPTY`, `RUNTIME_INPUT_TYPE_MISMATCH` |
| Runtime | existing calculation、snapshot、context與trading export errors |

Errors保留`phase`、`retryable`與safe context；不得包含完整private Pine source、compiler payload、cookies或credentials。

## Concurrency and restore

- V1 sequential Parameter Sets與Symbols；不在相同Pane平行mutation。
- Existing in-process Chart mutation mutex必須涵蓋整個automation run，不只單一Symbol。
- User手動切換Tab不影響resolved target；Layout／Pane ownership或Inputs外部改變則停止。
- Formal run意圖持久化latest Strategy revision／new entity；不恢復舊source version或old entity。
- Base Inputs與原始Chart Symbol／Timeframe必須在finally恢復並read back；restore失敗時run不得回報完整成功。

## Testing architecture

- Pure unit：config、scanner、schema comparison、fingerprints、Parameter Set planning。
- Deterministic Core integration：compiler adapters、Account source、Tab/Layout/Pane resolver、Watchlist two-read、Study inputs、sync transaction與cleanup。
- CLI contracts：help、required args、stdout/stderr、exit codes、dry-run no mutation與bounded summaries。
- Existing regression：`npm run lint`、`npm run test:unit`、`npm run test:cli`、`npm test`。
- Live validation：使用`dev` Layout、`dev-testing-list`、`TWSE:2330`與`data/obv-v3.pine`；mutation前保存ownership，僅操作明確測試Strategy，read back final state。Automated gate只執行bounded representative export，完整448-Symbol formal run由User依manual guide安排與驗收。

CI不連接TradingView Desktop；所有CDP、clock、filesystem、compiler response與Account APIs必須可注入。Live evidence寫入Task completion records，不將Account IDs、private source或generated artifacts加入repo fixtures。

## Task dependency rationale

- TASK-001先提供Candidate Schema，因為dry-run與sync都依賴新版source contract。
- TASK-002提供Runtime Input Catalog與name mutation，供schema readback與Parameter execution使用。
- TASK-003可獨立建立完整named Watchlist Snapshot。
- TASK-004在前三個contracts完成後交付完整read-only Run Config／resource resolution／dry-run slice。
- TASK-005依賴dry-run plan與Study inputs，實作Account／Pane sync transaction。
- TASK-006在fixed latest Strategy上實作Parameter Set execution與restore。
- TASK-007整合existing Strategy Trading export與canonical run artifacts，交付正式`strategy run`。
- TASK-008只做regression、live acceptance、文件與completion record，不新增功能。
