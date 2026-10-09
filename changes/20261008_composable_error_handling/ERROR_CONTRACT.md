# Composable Error Handling — Error Contract

Status: `proposed`

## Internal normalized error

```js
{
  name: 'CoreOperationError',
  message: 'CDP target discovery failed: fetch failed',
  code: 'CDP_DISCOVERY_FAILED',
  kind: 'cdp',
  stage: 'target_discovery',
  retryable: true,
  cause: Error, // private, never serialized
}
```

Allowed `kind` values：

| Kind | Meaning | Examples |
| --- | --- | --- |
| `validation` | Request、Config、resource availability validation | `RUN_CONFIG_REQUIRED`, `TARGET_LAYOUT_NOT_OPEN` |
| `identity` | Successfully resolved state differs from persisted/fixed identity | `RUN_EXTENSION_IDENTITY_MISMATCH` |
| `cdp` | CDP discovery/connect/command/timeout failure | `CDP_DISCOVERY_FAILED`, `CDP_TIMEOUT` |
| `filesystem` | Generic bounded filesystem operation failure | `OUTPUT_WRITE_FAILED` |
| `artifact` | Durable artifact contract or corruption failure | `RUN_RESUME_ARTIFACT_INVALID` |
| `conflict` | Ownership、lease、collision or immutable-state conflict | `RUN_OUTPUT_EXISTS`, `RUN_ALREADY_SUCCEEDED` |
| `interrupt` | Explicit process/user cancellation | `RUN_INTERRUPTED` |
| `internal` | Unexpected error after all known policies decline | `CORE_OPERATION_FAILED` |

`retryable`是explicit property；例如某些`cdp` error可在User重新啟動Desktop後重試，但同一operation是否
automatic retry仍由domain policy決定。

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
exit_code (130/143 only)
```

禁止輸出：

- `stack`
- `cause`
- raw HTTP/CDP responses
- filesystem contents
- Account tokens／cookies／private source
- arbitrary enumerable fields

Diagnostic object必須deep-freeze或視為immutable value。

## Cause precedence

Cause chain example：

```text
RUN_EXTENSION_IDENTITY_MISMATCH
  cause → RUN_RESUME_IDENTITY_MISMATCH
    cause → CDP_DISCOVERY_FAILED
      cause → TypeError("fetch failed")
```

Normalizer輸出最內層已知infrastructure error：

```json
{
  "code": "CDP_DISCOVERY_FAILED",
  "kind": "cdp",
  "stage": "target_discovery"
}
```

如果cause chain沒有infrastructure error，且stable target readback成功後ID不同，才輸出：

```json
{
  "code": "RUN_EXTENSION_IDENTITY_MISMATCH",
  "kind": "identity",
  "phase": "extension_identity"
}
```

## Result and thrown-error parity

Throw path：

```js
throw boundary.error(error);
```

Aggregated validation path：

```js
errors.push(boundary.diagnostic(error));
```

下列fields必須完全相同：

```text
code
kind
phase/stage
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
      "stage": "target_discovery",
      "retryable": true
    }
  ]
}
```

Outer result可暫時保留`failure_kind: "cdp_connection"`作compatibility，但authority是diagnostic kind。

## MCP output

MCP仍使用`isError: true`，text JSON payload與CLI相同Core fields：

```json
{
  "success": false,
  "code": "CDP_DISCOVERY_FAILED",
  "kind": "cdp",
  "error": "CDP target discovery failed: fetch failed",
  "stage": "target_discovery",
  "retryable": true
}
```

## Persisted artifact projection

Runtime normalized error寫入formal artifacts時：

```js
sanitizeStrategyRunError(error)
// => { code, phase, message }
```

`kind`、`retryable`、cause及transport metadata不persist，避免artifact schema drift與不穩定recovery behavior。

## Compatibility mapping

| Current condition | Target normalized result |
| --- | --- |
| `CdpOperationError` with `CDP_*` | Preserve code, `kind: cdp`。 |
| Raw target-discovery fetch failure | `CDP_DISCOVERY_FAILED`, `kind: cdp`。 |
| AbortError during discovery | `CDP_TIMEOUT` or explicit interrupt according to owning signal。 |
| `ENOENT` reading required artifact | Domain artifact code, `kind: artifact`。 |
| Output path already exists | Preserve `RUN_OUTPUT_EXISTS`, `kind: conflict`。 |
| Resume identity mismatch used by Extend | Translate to Extension identity only when no infrastructure cause exists。 |
| Unknown error | Bounded domain fallback or `CORE_OPERATION_FAILED`, `kind: internal`。 |
