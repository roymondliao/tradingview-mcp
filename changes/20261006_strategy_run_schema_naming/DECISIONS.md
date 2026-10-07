# Strategy Run Schema Naming — Design Decisions

Status: `approved`

## Decision register

| ID | Topic | Status | Decision |
| --- | --- | --- | --- |
| D-001 | Public field names | `accepted` | Formal artifact root使用`artifact_schema_version`；persisted requested Config使用`config_schema_version`。 |
| D-002 | Version boundary | `accepted` | 新格式為artifact v3；不得在artifact v2下改名。 |
| D-003 | Existing v2 Resume | `accepted` | Reader支援v2／v3；v2 Resume維持v2 serialization，不做implicit migration。 |
| D-004 | Artifact family consistency | `accepted` | 同一Run Directory的`run.json`、`experiment.json`與`manifest.json`必須屬於同一artifact family。 |
| D-005 | Config input boundary | `accepted` | User-facing Run Config維持`schema_version: 1`；只在persisted normalized request投影為`config_schema_version`。 |
| D-006 | Adjacent schemas | `accepted` | Watchlist validation、Trading Export與Report/Data/Snapshot/Reconciliation schema naming不在本Change修改。 |

## Accepted decisions

### D-001 Public field names

Decision:

```json
{
  "artifact_schema_version": 3,
  "requested": {
    "config_schema_version": 1
  }
}
```

`experiment.json`與Experiment `manifest.json`同樣使用root `artifact_schema_version: 3`。

Rationale:

- 欄位本身可指出它版本化的contract，不需依賴讀者記住所在層級。
- Error、telemetry、JSONPath與manual inspection可以直接區分artifact與Config versions。
- Flat field保持目前strict JSON validators和bounded reader簡單。

Rejected alternatives:

- `artifact: { schema_version }`加上`requested: { schema_version }`：整份文件已是artifact，wrapper沒有新增語意；nested requested key仍未指出Config contract。
- `schema: { type, version }`：是合理的全域envelope設計，但本次沒有producer、format、capabilities等共同metadata需求，導入成本超出目前問題。
- 保持同名欄位只補文件：無法改善程式輸出、query與manual inspection的歧義。

Compatibility impact:

- v3 consumers必須讀取新欄位。
- v2 consumers不會被要求解析v3。
- Dual-version reader負責既有v2 Resume。

Required tests:

- v3 round-trip retains explicit names。
- v3 rejects legacy key aliases。
- Error messages identify `artifact_schema_version` or `config_schema_version` exactly。

### D-002 Version boundary

Decision:

- 新artifact格式版本為3。
- 不在`schema_version: 2`下改變欄位名稱。
- `STRATEGY_RUN_ARTIFACT_VERSION`代表new-write version 3；legacy v2 support使用獨立constant，不讓單一constant同時表達current writer與all readable versions。

Rationale:

Strict v2 parser的allowed-field contract包含`schema_version`且拒絕unknown fields。重新命名會改變合法document shape，若仍標v2會讓同一version出現兩個互斥格式，破壞deterministic validation。

Rejected alternatives:

- 維持version 2並接受兩組alias：同一version不再有唯一schema。
- 同時輸出新舊兩個欄位：產生兩個authority，且值不一致時無法安全決定。

Failure behavior:

- 同時出現兩種root version fields時回傳artifact invalid。
- v3使用`requested.schema_version`或v2使用`requested.config_schema_version`時回傳artifact invalid。

Required tests:

- New writer只產生v3 shape。
- Cross-shaped version/name combinations全部拒絕。

### D-003 Existing v2 Resume

Decision:

- Resume繼續接受完整、合法的artifact v2 Run Directory。
- v2在memory中可normalize成共同domain model，但serializer必須記住source family。
- v2 Run的`run.json`與`manifest.json`後續atomic updates保持v2 keys和version。
- 不執行whole-directory、lazy或per-file migration。

Rationale:

Resume會更新多個durable files，filesystem無法對整個Run tree提供單一atomic transaction。逐檔升級會產生mixed-version crash window，降低原本durability guarantee。Format-preserving writes可保留現有recoverability而不需要migration protocol。

Rejected alternatives:

- Resume前in-place migration：需要multi-file journal／rollback，與純命名改善不成比例。
- 第一次update時逐檔轉v3：process crash後可能留下v2 Run加v3 manifest。
- 不再支援v2：會使既有未完成Run無法Resume。

Failure behavior:

- 任何formal artifact family與`run.json`不一致時，在TradingView mutation前回傳`RUN_RESUME_ARTIFACT_INVALID`。
- Unknown version回傳`RUN_RESUME_VERSION_UNSUPPORTED`。

Required tests:

- v2 running／failed fixtures可Resume。
- v2 Resume的每次persist後仍只有legacy fields。
- Injected write failure不產生mixed-version artifacts。

### D-004 Artifact family consistency

Decision:

`run.json`是Run Directory的family discriminator。所有existing `experiment.json`與Experiment `manifest.json`必須符合該family；new files也必須由同一family serializer建立。

Rules:

```text
v2 run → v2 experiment + v2 manifest
v3 run → v3 experiment + v3 manifest
```

若Experiment尚未建立，Resume依Run family建立；不得使用current writer default覆蓋persisted family。

Rationale:

一個Run tree使用單一formal artifact contract，才能讓crash recovery、manual inspection與offline consumers有穩定假設。

Required tests:

- v2/v3 cross-family fixture matrix。
- Missing Experiment state建立時繼承Run family。

### D-005 Config input boundary

Decision:

Existing Run Config仍接受：

```json
{ "schema_version": 1 }
```

Validated／normalized config進入v3 `run.json.requested`時輸出：

```json
{ "config_schema_version": 1 }
```

Rationale:

本問題發生在同一persisted artifact中兩種版本語意無法區分。直接修改User-facing Config會額外造成Config v2 migration，沒有改善artifact Resume safety。`requested`本來就是normalized projection，不是原始JSON copy。

Required tests:

- Existing Config v1 fixtures不需修改即可建立v3 Run。
- Config hash仍基於原始parsed Config contract，不因persisted projection改名而改變定義。

### D-006 Adjacent schemas

Decision:

以下不在本Change改名：

- `watchlist.json.symbol_validation.schema_version`
- Existing `strategy trading-export` v1 root `schema_version`
- `schema_versions` summary maps
- Report／Trading Data／Snapshot／Reconciliation／Pine Input schemas

Rationale:

這些欄位不會在同一scope同時表示Config與formal Run artifact。擴大修改會把單一clarity fix變成跨command schema redesign，增加consumer breakage與驗證範圍。
