---
id: FEATURE-20261006-STRATEGY-RUN-SCHEMA-NAMING
title: Strategy Run Schema Naming
status: done
created: 2026-10-06
depends_on:
  - FEATURE-20260926-STRATEGY-DURABLE-EXPORT-RECOVERY
scope:
  - durable-artifact-schema-v3
  - schema-field-naming
  - v2-resume-compatibility
---

# Strategy Run Schema Naming

Status: `done`

## Objective

消除 Formal Strategy Run artifacts 內不同 schema contract 共用 `schema_version` 名稱造成的歧義。目前 `run.json` 同時包含：

```json
{
  "schema_version": 2,
  "requested": {
    "schema_version": 1
  }
}
```

最外層數字代表 durable artifact schema，`requested` 內的數字代表 Strategy Run Config schema。兩者生命週期、相容性與 consumer 都不同，但單看欄位名稱無法辨識。

本 Change 將新產出的 Formal Strategy Run artifacts 升級為 v3，使用 purpose-specific 欄位名稱：

```json
{
  "artifact_schema_version": 3,
  "requested": {
    "config_schema_version": 1
  }
}
```

既有 artifact v2 仍可原地 Resume，且 Resume 後保持 v2 格式；本 Change 不對既有 Run Directory 做隱式或 in-place migration。

## Contract summary

### New Formal Run artifacts

新 Run 的三個 formal state artifacts 使用一致的根欄位：

| Artifact | v2 field | v3 field |
| --- | --- | --- |
| `run.json` | `schema_version: 2` | `artifact_schema_version: 3` |
| `experiment.json` | `schema_version: 2` | `artifact_schema_version: 3` |
| `manifest.json` | `schema_version: 2` | `artifact_schema_version: 3` |

`run.json.requested` 的 Config contract 欄位改名：

| Artifact | v2 field | v3 field |
| --- | --- | --- |
| `run.json.requested` | `schema_version: 1` | `config_schema_version: 1` |

欄位改名本身就是 schema breaking change，因此新格式不得繼續宣稱是 artifact v2。

### Existing Run Config input

User-facing Run Config input 維持 v1 與既有格式：

```json
{
  "schema_version": 1,
  "strategy": {},
  "target": {},
  "backtest": {},
  "experiments": {},
  "output": {}
}
```

Loader 驗證輸入後，寫入 artifact v3 的 normalized `requested` snapshot 時，將該值投影為 `requested.config_schema_version`。`requested` 已包含 generated Run ID、absolute paths 與 hashes，因此不是 raw Config byte-for-byte copy；使用不同、明確的欄位名稱不會假裝保留原始 JSON shape。

### Existing v2 runs

Artifact family 由 `run.json` 決定：

- `schema_version === 2` 且沒有 `artifact_schema_version`：legacy v2。
- `artifact_schema_version === 3` 且沒有 `schema_version`：v3。
- 兩個欄位同時存在、兩個欄位都不存在或版本未知：invalid／unsupported，不猜測。

Resume v2 時：

- 接受既有 v2 `run.json`、`experiment.json` 與 `manifest.json`。
- 驗證同一 Run Directory 的 formal artifacts 全部屬於 v2 family。
- 後續 atomic updates 繼續輸出 v2 欄位名稱與版本。
- 不把單一檔案升級為 v3，避免 mixed-version durable state。

Resume v3 時，所有 formal artifact updates 維持 v3。

## Naming rationale

採用：

```json
{
  "artifact_schema_version": 3,
  "requested": {
    "config_schema_version": 1
  }
}
```

不採用：

```json
{
  "artifact": {
    "schema_version": 3
  },
  "requested": {
    "schema_version": 1
  }
}
```

理由：

- 整份 `run.json` 已是 artifact，再建立只放版本的 `artifact` wrapper 沒有額外 domain value。
- Purpose-specific field 可在 log、JSONPath、error message、validator 與資料分析工具中直接辨識版本種類。
- `requested.schema_version` 仍未明示它屬於 Config contract。
- Flat scalar version field 可在 bounded read 後立即 dispatch validator，不需要額外 envelope traversal。

若未來所有 artifacts 需要統一的 type／version／producer metadata envelope，應另開 Change 一次設計完整 `schema: { type, version }` contract，不在本次只為單一數字建立不完整 wrapper。

## In scope

- Formal Strategy Run artifact v3 naming contract。
- `run.json`、`experiment.json`、Experiment `manifest.json` v3 writers and strict validators。
- `run.json.requested.config_schema_version` projection。
- v2／v3 reader dispatch and same-family consistency validation。
- Existing v2 Resume with format-preserving updates。
- CLI／Core errors、fixtures、unit tests、documentation與example updates。

## Out of scope

- 修改 User-facing Run Config v1 的 input key。
- 將既有 Run Directory rewrite 或 migrate 為 v3。
- Artifact v1 Resume 或 migration。
- Existing `strategy trading-export` v1 manifests。
- `watchlist.json.symbol_validation.schema_version`；它已由 `symbol_validation` namespace 明確限定，且是獨立 contract。
- Trading Report、Trading Data、Snapshot、Reconciliation、Pine Input schema versions。
- 新增通用 artifact metadata envelope、registry 或 database migration。

## Safety and compatibility properties

- 不得以欄位存在順序或其他 artifact content 猜測版本。
- 不得接受同時含有 `schema_version` 與 `artifact_schema_version` 的 formal artifact。
- 同一 Run Directory 不得混用 formal artifact v2 與 v3。
- Resume v2 不得部分轉寫成 v3。
- Unknown future versions回傳 `RUN_RESUME_VERSION_UNSUPPORTED`，不得以目前最高版本解析。
- Schema naming migration不得改變 Run／Experiment／Symbol status、identity、summary、retry或artifact publication semantics。
- Dry-run 維持 read-only，不建立 artifacts。

## Delivery sequence

```text
v3 schema contract and dual-version validators
  → v3 writers and normalized requested projection
  → format-preserving v2/v3 Resume updates
  → fixtures, documentation and regression gate
```

## Acceptance criteria

- [x] New formal runs only emit `artifact_schema_version: 3` at formal artifact roots。
- [x] New `run.json.requested` only emits `config_schema_version: 1`。
- [x] New formal artifacts do not emit ambiguous root `schema_version`。
- [x] Existing v2 runs Resume successfully and remain byte-shape-compatible v2 after updates。
- [x] Mixed、dual-field、missing-field、v1 and unknown future artifacts fail before TradingView mutation。
- [x] Existing Config v1 input remains accepted without User changes。
- [x] Trading Export、Watchlist validation與downstream report schemas remain unchanged。
- [x] Targeted tests、full unit suite、lint與`git diff --check` pass。

## Tasks

| ID | Task | Status | Depends on |
| --- | --- | --- | --- |
| [TASK-001](./TASK-001-schema-contract-and-compatibility.md) | Artifact v3 Contract and Dual-Version Validation | `done` | Durable Export Recovery |
| [TASK-002](./TASK-002-run-resume-integration.md) | Run Writers and Format-Preserving Resume | `done` | TASK-001 |
| [TASK-003](./TASK-003-regression-delivery.md) | Regression, Documentation and Delivery Gate | `done` | TASK-002 |

Detailed module design見[`LLD.md`](./LLD.md)，decision rationale見[`DECISIONS.md`](./DECISIONS.md)，驗證結果見[`DELIVERY_EVIDENCE.md`](./DELIVERY_EVIDENCE.md)。
