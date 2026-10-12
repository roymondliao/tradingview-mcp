# Composable Error Handling — Error Contract

Status: `accepted`

## Field contract

| Field | Required | Responsibility |
| --- | --- | --- |
| `name` | normalized error | Runtime carrier name。 |
| `message` | yes | Bounded、safe、human-readable incident reason。 |
| `code` | yes | Stable specific contract；描述「具體發生什麼」。 |
| `kind` | normalized runtime error | Small reason category；描述「為什麼失敗」，不表示位置。 |
| `phase` | phase or stage required | Domain workflow location。 |
| `stage` | phase or stage required | Source adapter technical sub-step。 |
| `retryable` | normalized runtime error | Caller retry policy；不代表automatic retry。 |
| `cause` | no, private | Internal debugging／composition only；never serialized。 |
| `exit_code` | signal only | 130／143；其他exit由presentation推導。 |

`phase`與`stage`可同時存在：

```js
{
  name: 'CoreOperationError',
  message: 'CDP target discovery failed: fetch failed',
  code: 'CDP_DISCOVERY_FAILED',
  kind: 'cdp',
  phase: 'extension_identity',
  stage: 'target_discovery',
  retryable: true,
  cause: Error, // private, never serialized
}
```

Source boundary通常擁有code／kind／stage／message；Domain boundary增加phase並保留source semantics。Domain
boundary自行產生semantic invariant error時可以只有phase，例如identity mismatch。

## Error kinds

| Kind | Meaning | Examples |
| --- | --- | --- |
| `validation` | Request、Config或resource availability validation | `RUN_CONFIG_REQUIRED`, `TARGET_LAYOUT_NOT_OPEN` |
| `identity` | 成功讀取後發現current state不同於persisted／fixed identity | `RUN_EXTENSION_IDENTITY_MISMATCH` |
| `cdp` | CDP discovery、connect、command或owned timeout failure | `CDP_DISCOVERY_FAILED`, `CDP_TIMEOUT` |
| `filesystem` | 沒有更具體domain semantics的generic filesystem failure | `OUTPUT_WRITE_FAILED` |
| `artifact` | Durable artifact不存在、contract invalid或corruption | `RUN_RESUME_ARTIFACT_INVALID` |
| `conflict` | Ownership、lease、collision或immutable-state conflict | `RUN_OUTPUT_EXISTS`, `RUN_ALREADY_SUCCEEDED` |
| `interrupt` | Explicit process/user/caller cancellation | `RUN_INTERRUPTED`, `RUN_CANCELLED` |
| `internal` | 所有known policies decline後仍無法分類 | `CORE_UNCLASSIFIED_ERROR` |

`kind`只提供cross-domain classification；具體行為仍由code與owner決定。`retryable`必須explicit指定。

## Boundary definitions

### Origin／Source boundary

最低一層、第一次接收到raw event，而且知道operation purpose與resource semantics的元件。它將raw event轉為
normalized code／kind／stage／message並保留private cause。

Examples：

| Owned operation | Raw event | Normalized result |
| --- | --- | --- |
| CDP target discovery | fetch failure | `CDP_DISCOVERY_FAILED / cdp / target_discovery` |
| Required `run.json` read | `ENOENT` | Owned artifact code／`artifact` |
| Immutable Run directory create | `EEXIST` | `RUN_OUTPUT_EXISTS / conflict` |
| Generic output write | `EACCES` | Owned write code／`filesystem` |
| CDP discovery deadline | owned AbortError | `CDP_TIMEOUT / cdp / target_discovery` |

### Domain boundary

Domain boundary增加workflow phase、保留normalized cause、做exact-code translation，或在成功取得資料後產生
validation／identity／conflict invariant error。它不得由raw errno、AbortError、message或code prefix重新分類。

### Presentation／Persistence boundary

Presentation輸出safe runtime diagnostic；Persistence只輸出artifact schema允許的fields。兩者都不得重新做
domain classification。

## Abort and signal contract

`AbortSignal`是carrier，不是kind。Classification依controller owner與`signal.reason`：

| Event／owner | Code | Kind | Phase／stage | Exit |
| --- | --- | --- | --- | ---: |
| SIGINT | `RUN_INTERRUPTED` | `interrupt` | current workflow／`process_signal` | 130 |
| SIGTERM | `RUN_INTERRUPTED` | `interrupt` | current workflow／`process_signal` | 143 |
| Explicit caller cancel | `RUN_CANCELLED` | `interrupt` | current workflow／`caller_cancel` | 1 |
| CDP deadline | `CDP_TIMEOUT` | `cdp` | current workflow／owned CDP stage | 2 |
| Cascade after primary failure | primary code | primary kind | primary phase／stage | primary policy |
| Lease／ownership loss | owned conflict code | `conflict` | current workflow／owned stage | 1 |
| Ownerless abort | `CORE_UNCLASSIFIED_ERROR` | `internal` | current workflow or abort stage | 1 |

Rules：

1. Controller應使用`abort(normalizedReason)`。
2. Receiver若看到normalized `signal.reason`，直接保留。
3. Owner-created deadline由owner轉為timeout，不能轉成interrupt。
4. Cascade cancellation輸出primary reason，不產生第二個假的`RUN_INTERRUPTED`。
5. 不得單靠`error.name === 'AbortError'`分類。
6. Historical persisted `phase: signal`保持可讀；新errors使用owning phase + `stage: process_signal`。

## Source semantics and precedence

Raw filesystem、network及AbortError先由source owner正規化。Higher-level boundary再依以下順序composition：

```text
1. preserve typed abort／process-signal reason
2. promote normalized or exact-known legacy cdp／generic filesystem cause
3. apply explicit exact-code domain translation
4. preserve already-normalized domain error
5. normalize remaining exact-known legacy code
6. create CORE_UNCLASSIFIED_ERROR fallback
```

Exact translation必須在generic normalized preservation之前，否則已正規化的Resume identity error永遠不會在
Extension boundary轉成Extension identity。Infrastructure cause promotion仍排在translation之前，避免outer
identity code覆蓋inner CDP／filesystem cause。

Cause chain example：

```text
legacy RUN_EXTENSION_IDENTITY_MISMATCH wrapper
  cause → legacy RUN_RESUME_IDENTITY_MISMATCH wrapper
    cause → CDP_DISCOVERY_FAILED / cdp / target_discovery
      cause → TypeError("fetch failed")
```

Normalizer輸出CDP semantics並加上目前domain phase：

```json
{
  "code": "CDP_DISCOVERY_FAILED",
  "kind": "cdp",
  "phase": "extension_identity",
  "stage": "target_discovery",
  "message": "CDP target discovery failed: fetch failed"
}
```

如果CDP readback成功後stable ID真的不同，domain才產生：

```json
{
  "code": "RUN_EXTENSION_IDENTITY_MISMATCH",
  "kind": "identity",
  "phase": "extension_identity",
  "message": "Resolved Layout or Pane differs from the parent Run."
}
```

Raw `ENOENT`不自動提升為filesystem。Required artifact owner應先產生artifact error；只有明確正規化為generic
`kind: filesystem`的cause才由higher boundary提升。

## Unknown fallback

所有known policies decline時，輸出：

```json
{
  "code": "CORE_UNCLASSIFIED_ERROR",
  "kind": "internal",
  "phase": "extension_identity",
  "message": "fetch failed",
  "retryable": false
}
```

Message選擇規則：

1. Bounded traversal中若存在known normalized error，不進入fallback。
2. 否則使用最深層可安全讀取的own `message` data property。
3. Primitive thrown value使用bounded string representation。
4. 最大1000 characters，移除不允許的control data。
5. 不包含stack、cause object、raw response、filesystem contents、tokens、cookies或private source。

Fallback可保留owning phase，但不得使用identity／validation等semantic code假裝已知道原因。

## Safe diagnostic

`toCoreDiagnostic(error)`只允許：

```text
code
kind
message
phase
stage
retryable
entity_id
symbol
context (sanitized allowlist)
timeout_ms
target_id
chart_id
signal (SIGINT or SIGTERM only)
exit_code (130 or 143 only)
```

禁止輸出：

- `stack`
- `cause`
- raw HTTP/CDP responses
- filesystem contents
- Account tokens／cookies／private source
- arbitrary enumerable fields

Diagnostic object是deterministic immutable value；implementation以explicit allowlist建立，不spread source object。

## Result and thrown-error parity

Throw path：

```js
throw boundary.error(error, context);
```

Aggregated path：

```js
errors.push(boundary.diagnostic(error, context));
```

下列fields必須完全相同：

```text
code
kind
phase
stage
message
retryable
safe context
```

## CLI output

Thrown failure：

```json
{
  "success": false,
  "code": "CDP_DISCOVERY_FAILED",
  "kind": "cdp",
  "error": "CDP target discovery failed: fetch failed",
  "phase": "extension_identity",
  "stage": "target_discovery",
  "retryable": true
}
```

Dry-run failure：

```json
{
  "success": false,
  "valid": false,
  "dry_run": true,
  "errors": [
    {
      "code": "CDP_DISCOVERY_FAILED",
      "kind": "cdp",
      "message": "CDP target discovery failed: fetch failed",
      "phase": "extension_identity",
      "stage": "target_discovery",
      "retryable": true
    }
  ]
}
```

Outer result可在migration期間保留`failure_kind: "cdp_connection"`，但authority是diagnostic kind。

## Exit policy

| Condition | Exit |
| --- | ---: |
| Success | 0 |
| SIGINT | 130 |
| SIGTERM | 143 |
| Top-level or aggregated reportable `kind: cdp` | 2 |
| All other failures, including non-POSIX caller cancellation | 1 |

Aggregation固定先檢查explicit 130／143，再檢查success，接著檢查top-level diagnostic與`errors[]`是否存在
`kind: cdp`，最後回傳1。不得依first error ordering或message文字決定。

## MCP output

MCP仍使用`isError: true`，text JSON payload與CLI使用相同Core fields：

```json
{
  "success": false,
  "code": "CDP_DISCOVERY_FAILED",
  "kind": "cdp",
  "error": "CDP target discovery failed: fetch failed",
  "phase": "extension_identity",
  "stage": "target_discovery",
  "retryable": true
}
```

## Persisted artifact projection and rehydration

Runtime normalized error寫入formal artifacts時：

```js
sanitizeStrategyRunError(error)
// => { code, phase, message }
```

`kind`、`stage`、`retryable`、cause及transport metadata不persist，避免artifact schema drift。

Read path：

```text
read and validate { code, phase, message }
  → Strategy-owned exact code-to-kind lookup
       ├─ found   → reconstruct runtime kind
       └─ unknown → preserve code/message, use kind: internal,
                    record unmapped compatibility evidence
  → runtime boundary／diagnostic
```

Rehydration不mutation disk artifact、不使用prefix／message heuristics，且必須涵蓋supported v2／v3／v4 stable
codes。Unknown persisted code不等於artifact corruption；它保留原始code及message，但runtime以internal分類。

## Compatibility mapping

| Current condition | Target normalized result |
| --- | --- |
| `CdpOperationError` | Preserve exact CDP code、`kind: cdp`及stage。 |
| Raw target-discovery fetch failure | Source maps to `CDP_DISCOVERY_FAILED / cdp`。 |
| Owner deadline during discovery | `CDP_TIMEOUT / cdp`；不是interrupt。 |
| SIGINT／SIGTERM reason | `RUN_INTERRUPTED / interrupt`, exit 130／143。 |
| `ENOENT` reading required artifact | Owned artifact code／`kind: artifact`。 |
| Output path already exists | Preserve `RUN_OUTPUT_EXISTS / conflict`。 |
| Generic filesystem failure | Owned code／`kind: filesystem`。 |
| Resume identity mismatch used by Extend | Translate only true semantic identity error。 |
| Unknown raw error | `CORE_UNCLASSIFIED_ERROR / internal` + bounded root-cause message。 |
