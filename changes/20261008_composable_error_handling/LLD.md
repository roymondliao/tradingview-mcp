# Composable Error Handling — Low-Level Design

Status: `proposed`

## 1. Module boundaries

| Module | Responsibility |
| --- | --- |
| `core/errors.js` | Error kinds、normalized carrier、bounded cause traversal、safe diagnostic projection。 |
| `core/error-policy.js` | Pure mapper composition、boundary factory、translation／fallback helpers。 |
| `connection.js` | CDP discovery/connect/command source normalization。 |
| `core/tab.js` | Consume injected normalized target discovery；no raw production fetch。 |
| `core/strategy-resume.js` | Resume semantic errors only；no infrastructure reclassification。 |
| `core/strategy-extend.js` | Compose Extension-specific translation and diagnostic aggregation。 |
| `core/strategy-run.js` | Reuse common preflight boundaries。 |
| `cli/router.js` | `toCoreDiagnostic()` delivery and kind-based exit code。 |
| `tools/_format.js` | MCP delivery from the same diagnostic projection。 |

`error-policy.js`不得import Strategy、artifact、CLI或MCP modules。

## 2. Core error carrier

```js
export const CORE_ERROR_KINDS = Object.freeze([
  'validation',
  'identity',
  'cdp',
  'filesystem',
  'artifact',
  'conflict',
  'interrupt',
  'internal',
]);

export class CoreOperationError extends Error {
  constructor(message, {
    code = 'CORE_OPERATION_FAILED',
    kind = 'internal',
    phase,
    stage,
    retryable = false,
    cause,
    ...boundedMetadata
  } = {}) { /* validate and project */ }
}
```

Constructor validates kind/code/phase bounds and never copies arbitrary source fields。

`CdpOperationError`可改為extends `CoreOperationError`，或由connection-private adapter立即轉換；public
callers只依Core contract，不依class identity。

## 3. Cause traversal

```js
export const CORE_ERROR_CAUSE_MAX_DEPTH = 16;

export function findErrorCause(error, predicate, {
  max_depth = CORE_ERROR_CAUSE_MAX_DEPTH,
} = {}) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth <= max_depth; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (predicate(current)) return current;
    current = current.cause;
  }
  return null;
}
```

Traversal不throw getter errors；implementation只接受normal Error／plain object own `cause`。

## 4. Mapper contract

```ts
type ErrorMapper = (error: unknown, context?: object) => CoreOperationError | null;
```

Rules：

- Pure；不得mutation error/context。
- Match時回normalized error。
- 不match回`null`，不得throw。
- Mapper output必須有known kind/code。
- Fallback mapper必須排最後且always match。

Composition：

```js
export function composeErrorMappers(...mappers) {
  return (error, context) => {
    for (const mapper of mappers) {
      const mapped = mapper(error, context);
      if (mapped) return mapped;
    }
    throw new TypeError('Error mapper chain requires a final fallback.');
  };
}
```

## 5. Reusable mappers

### Preserve interrupt

Match`RUN_INTERRUPTED`、owned AbortSignal reason及allowed 130／143 metadata。不得將ordinary discovery
timeout誤分類為user interrupt。

### Promote infrastructure cause

Bounded scan完整cause chain，優先找：

```text
kind: cdp
kind: filesystem
code prefix CDP_ (legacy adapter during migration)
```

Legacy raw network messages只允許在source adapter內判斷，不成為generic domain mapper。

### Preserve normalized error

若error已是complete Core contract，保留object或建立equivalent immutable copy。

### Translate codes

```js
translateErrorCodes({
  RUN_RESUME_IDENTITY_MISMATCH: {
    code: 'RUN_EXTENSION_IDENTITY_MISMATCH',
    kind: 'identity',
    phase: 'extension_identity',
  },
});
```

Translation保留message/cause，但只在前置infrastructure mapper decline後執行。

### Bounded fallback

Caller提供owned code/kind/phase及bounded message prefix；unknown properties不copy。

## 6. Boundary factory

```js
export function createErrorBoundary({ mappers, projection = toCoreDiagnostic }) {
  const normalize = composeErrorMappers(...mappers);
  return Object.freeze({
    normalize,
    error(error, context) {
      return normalize(error, context);
    },
    diagnostic(error, context) {
      return projection(normalize(error, context));
    },
  });
}
```

Domain owns boundary definition, not implementation primitives。

## 7. CDP target discovery

`connection.js` exports：

```js
export async function discoverCdpTargets({ timeout_ms, _deps } = {})
```

It owns：

- Host／port construction。
- Abort timeout。
- HTTP status and JSON shape validation。
- `CDP_DISCOVERY_FAILED`／`CDP_TIMEOUT` normalization。
- `kind: cdp`、stage／phase、retryable semantics。

`core/tab.js`：

```js
const discoverTargets = _deps.discoverTargets || discoverCdpTargets;
const targets = await discoverTargets();
```

Tests仍可inject arrays/errors，但production不得call global `fetch`。

## 8. Strategy boundary composition

```js
const extensionIdentityBoundary = createErrorBoundary({
  mappers: [
    preserveInterruptError,
    promoteInfrastructureCause,
    preserveKnownResourceError,
    translateErrorCodes({
      RUN_RESUME_IDENTITY_MISMATCH: {
        code: 'RUN_EXTENSION_IDENTITY_MISMATCH',
        kind: 'identity',
        phase: 'extension_identity',
      },
    }),
    boundedFallbackError({
      code: 'RUN_EXTENSION_IDENTITY_MISMATCH',
      kind: 'identity',
      phase: 'extension_identity',
    }),
  ],
});
```

Dry-run：

```js
errors.push(extensionIdentityBoundary.diagnostic(error));
```

Formal：

```js
throw extensionIdentityBoundary.error(error);
```

Run／Resume建立各自translation map，但共用interrupt/infrastructure/resource policies。

## 9. Diagnostic projection

`toCoreDiagnostic()` returns message field；delivery adapters rename only at outer envelope if compatibility requires：

```js
const diagnostic = toCoreDiagnostic(error);

// CLI/MCP envelope
{
  success: false,
  ...diagnostic,
  error: diagnostic.message,
}
```

避免CLI `handleError()`與MCP `coreErrorPayload()`各自重列safe field allowlist。Projection implementation只存在
Core一次。

## 10. Exit policy

```js
export function errorExitCode(diagnostic) {
  if (diagnostic.kind === 'interrupt') return diagnostic.exit_code;
  if (diagnostic.kind === 'cdp') return 2;
  return 1;
}
```

Result responses：若含`errors[]`，outer service應提供derived `failure_kind`／primary kind，或CLI從first
reportable diagnostic計算。Ordering由domain定義，CLI不排序。

## 11. Artifact projection

`sanitizeStrategyRunError()`繼續輸出exact：

```text
code
phase
message
```

Tests必須證明runtime kind不進入run／manifest／Symbol strict artifact validators。

## 12. Test matrix

### Pure combinators

- Mapper ordering、decline、fallback。
- Cause cycle、depth 16／17、non-Error values。
- Infrastructure promotion through two／three domain wrappers。
- Immutability and bounded projection。

### Infrastructure

- ECONNREFUSED／fetch failure → `CDP_DISCOVERY_FAILED`。
- Abort timeout → `CDP_TIMEOUT`。
- HTTP error／invalid JSON shape。
- `tab list`、Layout resolver and status share one discovery adapter。

### Domain

- CDP offline during Extension identity stays CDP。
- Layout missing stays resource validation。
- Stable saved Layout／Pane drift becomes Extension identity mismatch。
- Dry-run/formal parity for each case。

### Presentation

- CLI／MCP field parity。
- Exit 0／1／2／130／143。
- No message-regex dependency after migration。
- No stack/cause/private metadata leakage。
- Artifact error projection remains v2／v3／v4 compatible。
