# Strategy Run Update — Low-level Design

## Modules

| Module | Responsibility |
| --- | --- |
| `src/core/strategy-update.js` | 唯讀 preflight、完整實驗規劃、v5 Run 初始化、ownership 後再次驗證。 |
| `src/core/strategy-run-lineage.js` | 讀取來源 Extension chain；Update 作為新 root；fingerprint 包含 Update provenance。 |
| `src/core/strategy-run-state.js` | v2–v5 family dispatch、Update metadata 與 formal artifacts strict validation。 |
| `src/core/strategy-extend.js` | 來源為 v5 時建立 v5 Extension。 |
| `src/core/strategy-resume.js` | 共用 persisted evidence validation；回應包含 Update 來源與實驗數。 |
| `src/core/strategy-error-policy.js` | Update error kinds 與 composable boundary 支援。 |
| `src/cli/commands/strategy.js` | `update` options、help、signal／progress wrapper。 |
| `src/core/index.js` | 公開 `strategyUpdate` core namespace。 |

## Data flow

```text
source Run Directory
  → bounded lineage read and succeeded-artifact checks
  → persisted inputs/symbols/experiment identity validation
  → read-only runtime identity and candidate schema resolution
  → rebuild every parameter set from persisted base inputs
  → compare effective inputs/fingerprints with source plans
  → acquire existing Run/Pane ownership
  → reload source and revalidate identity/plan
  → executePreparedDurableRun
      → exclusive-create sibling directory
      → persist full plans and frozen Watchlist
      → validate Symbols and execute all experiments
      → restore/finalize/release
```

`dryRunStrategyUpdate()` 使用相同來源驗證與計畫建立路徑，但不呼叫 execution lifecycle。
`updateStrategyAutomation()` 不另行實作 retry、Symbol exporter 或 recovery。

## Artifact v5

Update 的 `run.json`、`experiment.json` 與 `manifest.json` 使用 v5。
`run.json.requested.config_schema_version` 維持 1。

`run.json.update` 欄位：

| Field | Meaning |
| --- | --- |
| `fingerprint_schema_version` | 固定為 1。 |
| `source_run_id` | 直接來源 Run ID，必須不同於新 Run。 |
| `source_artifact_schema_version` | 來源版本 2、3、4 或 5。 |
| `source_run_fingerprint` | 來源成功 Run 的 stable fingerprint。 |
| `source_lineage_fingerprint` | Extension 來源的 chain fingerprint；root 來源為 null。 |
| `parameter_sets_fingerprint` | 完整 requested parameter sets 的 fingerprint。 |
| `experiment_count` | 完整實驗數，必須與 requested 與 plans 長度一致。 |

僅 `run_kind: "update"` 可包含 `update` metadata；Update 不包含 `extension` metadata。
Source Config path/hash 沿用為來源紀錄，不重新讀取 Config。

## Lineage and recovery

來源 Extension chain 依 root→source 順序組合 parameter sets，重建為新 Run 的 local indexes
`0..N-1`。Update 的 provenance 不作為下一次 lineage traversal 的繼承 edge。

Lineage reader 維持 64 depth、4096 experiments、64 MiB JSON 的既有 bounds。
Update 讀取時不額外要求再新增一條 Extension edge 的容量；不繞過既有讀取 bounds。

Resume 只讀新 Run 的 artifacts，依該次 manifest 跳過成功 Symbols；原來源目錄不必存在。
新 Run 仍依賴保存的 Pine source path/hash 與匹配的 TradingView runtime。

Resume 時 `run.resolved.strategy` 保留原始 planning identity，因為 Experiment ID 包含其
entity ID。重綁的 runtime strategy 另傳入 execution 與 response，避免修改原始計畫 identity
而使後續 resume/update 驗證失敗。

## Error handling

Update boundary 將已知 Extension source／lineage errors 轉為 `RUN_UPDATE_SOURCE_NOT_FOUND`、
`RUN_UPDATE_SOURCE_NOT_SUCCEEDED`、`RUN_UPDATE_LINEAGE_INVALID` 或
`RUN_UPDATE_LINEAGE_LIMIT_EXCEEDED`；已知 Resume identity mismatch 轉為
`RUN_UPDATE_IDENTITY_MISMATCH`。不合法 CLI options 使用 `RUN_UPDATE_OPTION_INVALID`。

CDP infrastructure errors 保留原分類；未知錯誤維持 `CORE_UNCLASSIFIED_ERROR`。
Output collision 使用既有 `RUN_OUTPUT_EXISTS`，不覆寫現有目錄。
