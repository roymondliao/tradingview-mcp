---
id: FEATURE-20261008-COMPOSABLE-ERROR-HANDLING
title: Composable Error Handling
status: design
created: 2026-10-08
depends_on:
  - FEATURE-20261007-STRATEGY-RUN-EXTENSION
scope:
  - shared-error-contract
  - composable-error-policies
  - infrastructure-normalization
  - diagnostic-parity
---

# Composable Error Handling

Status: `design`

## Objective

將目前「shared `CoreOperationError` + module-local wrapping + CLI／MCP各自projection」的混合錯誤處理，
重構為可組合的Error policies。Infrastructure errors必須在source boundary被正規化；domain boundaries只
翻譯自己擁有的semantic errors；dry-run、formal execution、CLI與MCP使用同一safe diagnostic contract。

本Feature不建立一個知道所有domain的global handler，也不以大量Error subclasses形成inheritance tree。
共用的是small pure mappers、cause-chain traversal、boundary combinators及presentation policies，各domain
透過composition選擇需要的policy。

## Motivating failure

`strategy extend --dry-run`在TradingView CDP不可用時曾回傳：

```json
{
  "code": "RUN_EXTENSION_IDENTITY_MISMATCH",
  "phase": "extension_identity",
  "message": "Unable to resolve the persisted Layout and Pane."
}
```

實際cause是：

```text
core/tab.js raw fetch
  → TypeError("fetch failed")
  → Resume identity wrapper
  → RUN_RESUME_IDENTITY_MISMATCH
  → Extension translation
  → RUN_EXTENSION_IDENTITY_MISMATCH
```

同時間`tv status`可正確回傳`CDP_DISCOVERY_FAILED`，代表錯誤來源相同，但因不同module走不同boundary，
public semantics與exit behavior不一致。

完成後，上述情況必須回傳：

```json
{
  "success": false,
  "code": "CDP_DISCOVERY_FAILED",
  "kind": "cdp",
  "stage": "target_discovery",
  "error": "CDP target discovery failed: fetch failed",
  "retryable": true
}
```

而真正的stable identity drift才使用`RUN_EXTENSION_IDENTITY_MISMATCH`。

## Current-state assessment

| Layer | Current behavior | Gap |
| --- | --- | --- |
| Core carrier | `CoreOperationError`提供code／phase／context／cause | 沒有required category／kind。 |
| CDP transport | `connection.js`有`CdpOperationError`與部分normalization | `core/tab.js`仍直接raw fetch。 |
| Domain modules | 約55個local error helpers／wrappers | Catch-and-wrap可能覆蓋infrastructure semantics。 |
| Dry-run | `strategy-run.js`／`strategy-extend.js`各自產生diagnostics | 與formal thrown-error path可能不同。 |
| CLI | `router.js`統一JSON serialization | Exit 2仍部分依賴message regex。 |
| MCP | `tools/_format.js`統一bounded payload | 與CLI重複projection fields，沒有kind parity。 |
| Artifacts | Persisted error只保存code／phase／message | 不應因runtime error refactor升artifact version。 |

## Target architecture

```text
source adapter
  → normalize infrastructure error
  → preserve cause chain
  → domain boundary composition
       1. interrupt policy
       2. infrastructure promotion
       3. existing stable Core error
       4. domain translation
       5. bounded fallback
  → safe diagnostic projection
       ├── dry-run errors[]
       ├── formal thrown error
       ├── CLI JSON + exit policy
       └── MCP error result
```

Proposed modules：

```text
src/core/errors.js
  CoreOperationError
  ERROR_KINDS
  findErrorCause
  toCoreDiagnostic

src/core/error-policy.js
  composeErrorMappers
  createErrorBoundary
  preserveInterruptError
  promoteInfrastructureCause
  translateErrorCodes
  boundedFallbackError

src/connection.js
  discoverCdpTargets
  CdpOperationError/CoreOperationError adapter

src/cli/router.js
  diagnostic serialization
  exitCodeForDiagnostic

src/tools/_format.js
  same diagnostic projection for MCP
```

## Core principles

### 1. Normalize at the source

Raw `fetch`、CDP、filesystem及Abort errors應在最低可識別boundary轉為structured Core error。Higher-level
domain code不得靠message regex重新猜測transport type。

### 2. Infrastructure cause wins

若cause chain包含`cdp`、`filesystem`或`interrupt`，domain wrapper不得把它轉成identity／validation。
Domain translation只適用於沒有更高優先級cause的semantic errors。

### 3. One boundary, two projections

同一個boundary同時提供：

```js
boundary.error(error)       // formal throw path
boundary.diagnostic(error)  // dry-run aggregation path
```

兩者必須產生相同code、kind、phase及retry semantics。

### 4. Presentation does not classify

CLI與MCP只做safe projection及delivery。它們不得依message內容猜測error kind，也不得重新命名domain code。

### 5. Persisted artifacts stay stable

`run.json.error`、manifest error及Symbol error仍保存strict `{ code, phase, message }`。Internal/public runtime
diagnostic新增`kind`不改變artifact v2／v3／v4 schemas。

## Error kinds

第一版固定：

```text
validation
identity
cdp
filesystem
artifact
conflict
interrupt
internal
```

`kind`描述錯誤類別，`code`描述穩定的具體contract。`retryable`仍是explicit policy，不從kind自動推導。

完整欄位與precedence見[`ERROR_CONTRACT.md`](./ERROR_CONTRACT.md)。

## Migration strategy

採incremental vertical slices，避免big-bang rewrite：

1. 建立shared contract、mappers、boundaries及parity tests。
2. 統一CDP target discovery，移除`core/tab.js` direct raw fetch。
3. 遷移Strategy Run／Resume／Extend，修正motivating failure。
4. 讓CLI與MCP使用相同diagnostic projection及kind-based exit policy。
5. 依inventory逐批遷移其餘Core modules並移除message heuristics。

Migration期間既有stable codes保持不變；尚未遷移的module可透過fallback adapter進入新projection，但必須在
inventory中可追蹤，不得靜默視為完成。

## In scope

- `CoreOperationError` required internal kind及safe cause-chain utilities。
- Composable pure error mappers and boundary factory。
- CDP target discovery single authority。
- Strategy Run／Resume／Extend dry-run/formal parity。
- CLI／MCP diagnostic projection parity。
- Kind-based CLI exit codes with compatibility fallback during migration。
- Repository error-helper inventory、tests、documentation and migration gate。

## Out of scope

- 改變既有successful response schemas。
- 將stack、raw cause、HTTP response或Account data暴露給User。
- 以automatic retry取代各domain既有retry policy。
- 修改formal artifact error schema或升級artifact version。
- 將所有錯誤壓成單一generic code。
- 建立跨process logging／telemetry backend。

## Acceptance criteria

- [ ] CDP unavailable時，`strategy extend --dry-run`回傳`CDP_DISCOVERY_FAILED`／`kind: cdp`，不回傳identity mismatch。
- [ ] Layout missing、stable Layout drift與CDP failure三者有不同stable codes／kinds。
- [ ] Dry-run diagnostic與formal thrown path對相同cause產生相同contract。
- [ ] CLI及MCP對同一Core error輸出相同code、kind、phase、retryable。
- [ ] CLI exit code不再依message regex判定CDP failure。
- [ ] Cause-chain cycle／depth有fixed bound，projection不暴露cause或stack。
- [ ] Existing public codes、v2／v3／v4 Resume及persisted artifact schemas無regression。
- [ ] Node 22／24 unit、lint、durable、pack及targeted fault matrix通過。

## Tasks

| ID | Task | Status | Depends on |
| --- | --- | --- | --- |
| [TASK-001](./TASK-001-error-contract-combinators.md) | Shared Error Contract and Combinators | `todo` | Current `CoreOperationError` |
| [TASK-002](./TASK-002-infrastructure-normalization.md) | Infrastructure Boundary Normalization | `todo` | TASK-001 |
| [TASK-003](./TASK-003-domain-presentation-integration.md) | Domain Boundaries and Presentation Parity | `todo` | TASK-002 |
| [TASK-004](./TASK-004-regression-migration-delivery.md) | Regression, Migration and Delivery | `todo` | TASK-003 |

Detailed decisions見[`DECISIONS.md`](./DECISIONS.md)，low-level design見[`LLD.md`](./LLD.md)。
