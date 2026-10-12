# Composable Error Handling — Low-Level Design

Status: `accepted`

## 1. Module boundaries

| Module | Responsibility |
| --- | --- |
| `core/errors.js` | Error kinds、carrier、normalized-contract checks、bounded cause traversal、safe diagnostic projection。 |
| `core/error-policy.js` | Pure mapper composition、boundary factory、preservation／translation／fallback helpers。 |
| `connection.js` | CDP discovery/connect/command及owned deadline source normalization。 |
| `core/tab.js` | Consume injected normalized target discovery；no raw production fetch。 |
| `core/artifacts.js` | Generic artifact／filesystem operation ownership。 |
| `core/strategy-run-artifacts.js` | Strategy durable artifact semantics及strict persisted projection。 |
| `core/strategy-resume.js` | Resume domain phase、semantic identity errors、persisted code rehydration。 |
| `core/strategy-extend.js` | Extension phase、exact translation及diagnostic aggregation。 |
| `core/strategy-run.js` | Run domain phase及common preflight boundaries。 |
| `cli/commands/strategy.js` | POSIX signal owner及typed AbortSignal reason。 |
| `cli/router.js` | `toCoreDiagnostic()` delivery and fixed exit policy。 |
| `tools/_format.js` | MCP delivery from the same diagnostic projection。 |

`error-policy.js`不得import Strategy、artifact、CLI或MCP modules。Domain code maps留在擁有它們的domain。

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
    code = 'CORE_OPERATION_FAILED', // legacy carrier default; fallback uses CORE_UNCLASSIFIED_ERROR
    kind, // migration期間optional；normalized boundary output required
    phase,
    stage,
    entity_id,
    symbol,
    retryable = false,
    context,
    timeout_ms,
    target_id,
    chart_id,
    signal,
    exit_code,
    cause,
  } = {}) { /* validate explicit fields only */ }
}
```

Rules：

- 不使用`...boundedMetadata`，所有metadata明確列出並validate／bound。
- 有提供kind時必須是known value；不得以`kind = internal`掩蓋legacy call site。
- `isNormalizedCoreError(error)`要求bounded non-empty code、known kind、message、retryable及phase／stage至少一個。
- 新增或已遷移的constructor call必須explicit kind。
- Compatibility mapper可接受legacy missing-kind error，但presentation只能接收normalized error。
- `signal`只接受SIGINT／SIGTERM；`exit_code`只接受130／143且必須與signal一致。

`CdpOperationError`直接extends `CoreOperationError`並固定`kind: cdp`。Public callers依Core contract，不依
class identity。

## 3. Field enrichment

Source boundary先建立：

```text
code + kind + stage + message + retryable + private cause
```

Domain boundary可建立equivalent immutable copy增加owning phase：

```text
preserve code + kind + stage + message + retryable
add/replace phase with current owned workflow phase
```

Domain boundary不得覆寫source stage或將source code翻譯成不相關domain semantic code。True semantic translation
只透過exact map。

## 4. Cause traversal

最多檢查16個object nodes，root算第一個node；第17個node不讀取：

```js
export const CORE_ERROR_CAUSE_MAX_NODES = 16;

function ownDataProperty(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

export function findErrorCause(error, predicate, {
  max_nodes = CORE_ERROR_CAUSE_MAX_NODES,
} = {}) {
  const seen = new Set();
  let current = error;
  for (let visited = 0; isTraversableErrorValue(current) && visited < max_nodes; visited += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (predicate(current)) return current;
    current = ownDataProperty(current, 'cause');
  }
  return null;
}
```

Traversal只接受normal Error或plain object，且只讀own data-property `cause`；accessor getter不呼叫。Predicate
也只讀owned projected fields，不能spread、serialize或反射整個source object。

同一bounded traversal utility亦供root-cause message selection使用。

## 5. Mapper contract

```ts
type ErrorMapper = (error: unknown, context?: object) => CoreOperationError | null;
```

Rules：

- Pure；不得mutation error/context。
- Match時回normalized error。
- 不match回`null`，不得throw。
- Mapper output必須通過`isNormalizedCoreError()`。
- Fallback mapper必須排最後且always match。

```js
export function composeErrorMappers(...mappers) {
  assertFinalFallback(mappers);
  return (error, context) => {
    for (const mapper of mappers) {
      const mapped = mapper(error, context);
      if (!mapped) continue;
      assertNormalizedCoreError(mapped);
      return mapped;
    }
    throw new TypeError('Error mapper chain requires a final fallback.');
  };
}
```

## 6. Reusable mappers

### Preserve owned abort reason

`preserveOwnedAbortReason`只match以下情況：

- `signal.reason`已是normalized error。
- Current error／cause已是`RUN_INTERRUPTED / interrupt`。
- Allowed SIGINT／SIGTERM metadata與130／143一致。

Ordinary `AbortError`不match；deadline、caller與cascade semantics由controller owner在source產生。

### Promote normalized infrastructure cause

Bounded scan只提升：

```text
kind: cdp
kind: filesystem
```

Migration compatibility可以透過explicit known-code map補kind後再提升。Generic promotion不得使用`CDP_` prefix、
raw errno或network message heuristic。Artifact與conflict已具有更精確semantics，不當作generic filesystem提升。

Promoted copy保留source code／kind／stage／message／retryable，並加入current domain phase。

### Preserve normalized error

若error已符合完整Core contract，保留object或建立equivalent immutable copy；context指定owning phase時只做field
enrichment，不重新分類。

### Normalize legacy exact codes

```js
normalizeLegacyCodes({
  RUN_OUTPUT_EXISTS: { kind: 'conflict' },
  RUN_RESUME_ARTIFACT_INVALID: { kind: 'artifact' },
});
```

Map由domain owner提供。沒有mapping就decline，不使用prefix／substring。

### Translate exact codes

```js
translateErrorCodes({
  RUN_RESUME_IDENTITY_MISMATCH: {
    code: 'RUN_EXTENSION_IDENTITY_MISMATCH',
    kind: 'identity',
    phase: 'extension_identity',
  },
});
```

Translation保留bounded message／private cause，只在前置abort及infrastructure mappers decline後執行，並排在
generic normalized preservation之前。

### Bounded unclassified fallback

```js
boundedUnclassifiedError({
  phase: 'extension_identity',
});
```

固定輸出：

```text
code: CORE_UNCLASSIFIED_ERROR
kind: internal
retryable: false
phase: owned workflow when available
message: bounded safe deepest root-cause message
```

Unknown properties不copy，fallback不得接受identity／validation等domain code。

## 7. Boundary factory

```js
export function createErrorBoundary({
  phase,
  mappers,
  projection = toCoreDiagnostic,
}) {
  const normalizeMapped = composeErrorMappers(...mappers);
  const normalize = (error, context = {}) => enrichOwnedPhase(
    normalizeMapped(error, { ...context, phase }),
    phase,
  );
  return Object.freeze({
    normalize,
    error: normalize,
    diagnostic(error, context) {
      return projection(normalize(error, context));
    },
  });
}
```

Domain owns boundary definition與phase；shared factory只執行順序、validation及projection。

## 8. Abort ownership implementation

### POSIX process signal

`withStrategyAutomationSignals()` owns SIGINT／SIGTERM：

```js
controller.abort(new CoreOperationError(`Received ${signalName}.`, {
  code: 'RUN_INTERRUPTED',
  kind: 'interrupt',
  phase: currentPhase,
  stage: 'process_signal',
  signal: signalName,
  exit_code: SIGNAL_EXIT_CODES[signalName],
}));
```

Receiver保留reason，不再建立第二個generic interrupted wrapper。Historical `phase: signal` artifacts仍可讀。

### Owned deadline

Timer owner建立typed timeout reason或保留explicit `deadlineExpired` state：

```js
const reason = new CdpOperationError(
  `CDP target discovery timed out after ${timeoutMs}ms`,
  {
    code: 'CDP_TIMEOUT',
    stage: 'target_discovery',
    timeout_ms: timeoutMs,
    retryable: true,
  },
);
controller.abort(reason);
```

Fetch丟出的AbortError只是private cause；public error使用typed reason。

### Caller cancellation

Explicit external caller cancellation使用`RUN_CANCELLED / interrupt`，沒有POSIX exit metadata，因此CLI exit 1。

### Cascade cancellation

Worker coordinator使用primary normalized error作abort reason。被取消worker不得以`RUN_INTERRUPTED`覆蓋primary
error。

### Ownerless abort

無typed reason且owner無法證明deadline／caller semantics時，進入`CORE_UNCLASSIFIED_ERROR / internal`，並保留
bounded safe AbortError message。

## 9. CDP target discovery source boundary

`connection.js` exports：

```js
export async function discoverCdpTargets({ timeout_ms, signal, _deps } = {})
```

It owns：

- Host／port construction。
- Owner deadline與external typed reason composition。
- HTTP status and JSON shape validation。
- `CDP_DISCOVERY_FAILED`／`CDP_TIMEOUT` normalization。
- `kind: cdp`、`stage: target_discovery`及explicit retryable semantics。

`core/tab.js`：

```js
const discoverTargets = _deps.discoverTargets || discoverCdpTargets;
const targets = await discoverTargets();
```

Tests仍可inject arrays/errors，但production不得call global `fetch`。

## 10. Filesystem and artifact source boundaries

Filesystem classification依owned operation，不依errno alone：

```text
read required formal artifact
  → missing／invalid／corrupt → artifact

create immutable Run output or acquire lease
  → exists／owned／collision → conflict

generic read／write／rename／fsync without stronger semantics
  → filesystem
```

Source error保留raw filesystem error作private cause。Higher Strategy boundary只看到normalized result。

## 11. Strategy boundary composition

```js
const extensionIdentityBoundary = createErrorBoundary({
  phase: 'extension_identity',
  mappers: [
    preserveOwnedAbortReason,
    promoteInfrastructureCause({
      legacy_codes: STRATEGY_LEGACY_INFRASTRUCTURE_KINDS,
    }),
    translateErrorCodes({
      RUN_RESUME_IDENTITY_MISMATCH: {
        code: 'RUN_EXTENSION_IDENTITY_MISMATCH',
        kind: 'identity',
      },
    }),
    preserveNormalizedError,
    normalizeLegacyCodes(EXTENSION_LEGACY_ERROR_KINDS),
    boundedUnclassifiedError(),
  ],
});
```

Unknown fallback不能使用`RUN_EXTENSION_IDENTITY_MISMATCH`。只有known Resume identity error，或Extension成功
讀取後自行偵測的stable drift，才能使用Extension identity code。

Dry-run：

```js
errors.push(extensionIdentityBoundary.diagnostic(error));
```

Formal：

```js
throw extensionIdentityBoundary.error(error);
```

Run／Resume建立各自exact maps，但共用abort preservation、normalized infrastructure promotion及fallback primitive。

## 12. Diagnostic projection

`toCoreDiagnostic()`只接受normalized error，並從一份explicit allowlist建立immutable value：

```js
const diagnostic = toCoreDiagnostic(error);

// CLI/MCP compatibility envelope
{
  success: false,
  ...diagnostic,
  error: diagnostic.message,
}
```

Delivery adapter若輸出`error`，應避免同時重複輸出`message`，但Core parity比較基於normalize後的diagnostic。
CLI `handleError()`與MCP `coreErrorPayload()`不再各自維護field allowlist。

## 13. Exit policy

```js
export function diagnosticExitCode(diagnostic) {
  if ([130, 143].includes(diagnostic?.exit_code)) return diagnostic.exit_code;
  if (diagnostic?.kind === 'cdp') return 2;
  return 1;
}

export function resultExitCode(result) {
  if ([130, 143].includes(result?.exit_code)) return result.exit_code;
  if (result?.success !== false) return 0;
  const diagnostics = collectReportableDiagnostics(result);
  if (diagnostics.some((item) => item.kind === 'cdp')) return 2;
  if (result?.failure_kind === 'cdp_connection') return 2; // migration only
  return 1;
}
```

`collectReportableDiagnostics()`只讀top-level normalized diagnostic及bounded `errors[]`，不排序、不讀message。
Migration完成後刪除`failure_kind` compatibility branch。

## 14. Artifact projection and kind rehydration

`sanitizeStrategyRunError()`繼續輸出exact：

```text
code
phase
message
```

Strategy domain維護supported persisted codes的exact map：

```js
const STRATEGY_RUN_ERROR_KINDS = Object.freeze({
  CDP_DISCOVERY_FAILED: 'cdp',
  CDP_TIMEOUT: 'cdp',
  RUN_INTERRUPTED: 'interrupt',
  RUN_OUTPUT_EXISTS: 'conflict',
  RUN_RESUME_ARTIFACT_INVALID: 'artifact',
  // reviewed supported v2/v3/v4 codes
});

export function rehydrateStrategyRunError(record) {
  const kind = STRATEGY_RUN_ERROR_KINDS[record.code] || 'internal';
  return new CoreOperationError(record.message, {
    code: record.code,
    kind,
    phase: record.phase,
  });
}
```

Unknown persisted code保留原code／phase／message，runtime kind設為internal並透過test／observability seam記錄。
Rehydration不mutation artifact，不將kind寫回disk，不使用prefix或message。

## 15. Test matrix

### Field contract and pure combinators

- Kind／code／phase／stage responsibility及invalid values。
- Legacy missing-kind accepted before normalization；presentation rejects it。
- Mapper ordering、decline、fallback與exact maps。
- Cause cycle、16／17 nodes、getter cause及non-Error values。
- Unknown fallback使用deepest bounded safe message及`CORE_UNCLASSIFIED_ERROR`。
- Immutability and explicit diagnostic allowlist。

### Abort ownership

- SIGINT → interrupt／130；SIGTERM → interrupt／143。
- Caller cancel → interrupt／1。
- CDP owned deadline → cdp／2，不是interrupt。
- Cascade cancellation preserves primary error。
- Lease loss remains conflict。
- Ownerless AbortError becomes unclassified internal。
- Historical `phase: signal` artifact remains readable。

### Source boundaries

- ECONNREFUSED／fetch failure → `CDP_DISCOVERY_FAILED / cdp`。
- CDP deadline → `CDP_TIMEOUT / cdp`。
- HTTP error／invalid JSON shape。
- `tab list`、Layout resolver and status share one discovery adapter。
- Required artifact ENOENT → artifact。
- Immutable output EEXIST → conflict。
- Generic filesystem write failure → filesystem。

### Domain

- CDP offline during Extension identity keeps source code／kind／stage and gains Extension phase。
- Layout missing stays resource validation。
- Stable saved Layout／Pane drift becomes Extension identity mismatch。
- Unknown error does not become identity mismatch。
- Dry-run/formal parity for each case。

### Presentation and persistence

- CLI／MCP Core field parity。
- Exit 0／1／2／130／143 and aggregated mixed errors。
- No message-regex／prefix classification after migration。
- No stack／cause／private metadata leakage。
- Artifact projection remains exact v2／v3／v4 shape。
- Persisted exact-code kind rehydration and unknown-code fallback。
