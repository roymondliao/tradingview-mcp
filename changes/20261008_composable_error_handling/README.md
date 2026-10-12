---
id: FEATURE-20261008-COMPOSABLE-ERROR-HANDLING
title: Composable Error Handling
status: planned
created: 2026-10-08
depends_on:
  - FEATURE-20261007-STRATEGY-RUN-EXTENSION
scope:
  - shared-error-contract
  - composable-error-policies
  - source-boundary-normalization
  - diagnostic-parity
---

# Composable Error Handling

Status: `planned`

## Objective

將目前「shared `CoreOperationError` + module-local wrapping + CLI／MCP各自projection」的混合錯誤處理，
重構為三層可組合模型：Origin／Source boundary、Domain boundary及Presentation／Persistence boundary。

- Source boundary在最低且擁有操作語意的層級，將raw system／library event正規化。
- Domain boundary只增加workflow context、保留已知cause、執行explicit translation或產生domain invariant error。
- Presentation／Persistence boundary只投影，不依message或code prefix重新分類。

本Feature不建立知道所有domain的global handler，也不以大量Error subclasses形成inheritance tree。共用的是
small pure mappers、bounded cause traversal、boundary combinators及presentation policies；各domain透過composition
選擇需要的policy與exact code map。

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
  "phase": "extension_identity",
  "stage": "target_discovery",
  "error": "CDP target discovery failed: fetch failed",
  "retryable": true
}
```

只有成功讀取current identity後確認stable value不同，才能產生`RUN_EXTENSION_IDENTITY_MISMATCH`。

## Field responsibilities

| Field | Question answered | Contract |
| --- | --- | --- |
| `code` | 具體發生什麼錯誤？ | Stable、精確、可程式判斷；不得由message猜測。 |
| `kind` | 為什麼失敗、屬於哪一類？ | 小型固定enum，用於cross-domain policy；不表示發生位置。 |
| `phase` | 哪個domain workflow正在執行？ | Run／Resume／Extend等高階階段；不以`signal`代替workflow。 |
| `stage` | 底層哪個技術步驟失敗？ | Source adapter擁有的低階步驟，可與phase同時存在。 |
| `message` | 這次實際發生什麼？ | Bounded、safe、human-readable root-cause description。 |
| `retryable` | 呼叫者是否可重新發起？ | Explicit policy；不由kind自動推導，也不代表automatic retry。 |
| `exit_code` | CLI process如何結束？ | Presentation policy依normalized diagnostic決定。 |

Example：

```json
{
  "code": "CDP_DISCOVERY_FAILED",
  "kind": "cdp",
  "phase": "extension_identity",
  "stage": "target_discovery",
  "message": "connect ECONNREFUSED 127.0.0.1:9222",
  "retryable": true
}
```

## Boundary ownership

### Origin／Source boundary

Source boundary是最低一層、第一次接收到raw system／library event，而且知道「正在執行什麼操作」的元件。
它必須：

1. 直接擁有external transport、filesystem、runtime API或timer operation。
2. 知道該operation的目的與resource semantics。
3. 不依message猜測，即可指定stable code、kind及stage。

相同errno可因operation semantics而有不同kind：

```text
ENOENT while reading required run.json  → artifact
EEXIST while creating immutable Run     → conflict
EACCES during generic output write      → filesystem
```

### Domain boundary

Domain boundary不重新判斷raw fetch／errno／AbortError。它只負責：

- 加上目前workflow `phase`。
- 保留已正規化的source error及cause semantics。
- 只對自己擁有的known semantic code做explicit translation。
- 在成功取得必要資料後，產生validation、identity或conflict等domain invariant error。

### Presentation／Persistence boundary

CLI與MCP使用同一safe diagnostic projection；artifact使用既有strict projection。此層不得依message、code
prefix或runtime class重新分類。

## Error workflow

```text
Operation result／raw event
          │
          ▼
是否已是normalized error？
          ├─ yes → preserve code／kind／message
          └─ no
               │
               ▼
        誰擁有這個event？
               │
       ┌───────┼────────┬──────────────┐
       │       │        │              │
 Process    Deadline   Cascade       Raw system/
 signal     controller abort         library error
       │       │        │              │
       ▼       ▼        ▼              ▼
 interrupt  owner的   preserve      Source boundary
            timeout    original      依operation語意分類
                       reason
       └───────┴────────┴──────────────┘
                       │
                       ▼
               Normalized error
                       │
                       ▼
               Domain boundary
          attach phase／explicit translation
                       │
                       ▼
             CLI／MCP／Artifact projection
```

`AbortSignal`是傳遞停止事件的mechanism，不是error classification。真正語意由controller owner與
`signal.reason`決定；不得將所有`AbortError`分類為interrupt。

## Current-state assessment

| Layer | Current behavior | Gap |
| --- | --- | --- |
| Core carrier | `CoreOperationError`提供code／phase／context／cause | Normalized contract沒有required kind，field ownership未固定。 |
| CDP transport | `connection.js`有`CdpOperationError`與部分normalization | `core/tab.js`仍直接raw fetch；timeout abort reason不完整。 |
| Domain modules | 約55個local error helpers／wrappers | Catch-and-wrap可能覆蓋source semantics。 |
| Dry-run | `strategy-run.js`／`strategy-extend.js`各自產生diagnostics | 與formal thrown-error path可能不同。 |
| CLI | `router.js`統一JSON serialization | Exit 2仍部分依賴message regex。 |
| MCP | `tools/_format.js`統一bounded payload | 與CLI重複projection fields，沒有kind parity。 |
| Artifacts | Persisted error只保存code／phase／message | Runtime kind需要exact code rehydration，不應升artifact version。 |

## Target architecture

```text
Origin／Source boundary
  → normalize raw event with code／kind／stage／message
  → preserve private cause
  → Domain boundary composition
       1. preserve typed abort reason／interrupt
       2. promote normalized／exact-known legacy infrastructure cause
       3. explicit exact-code domain translation
       4. preserve normalized domain error
       5. normalize remaining exact-known legacy code
       6. CORE_UNCLASSIFIED_ERROR fallback
  → attach owning workflow phase
  → Presentation／Persistence projection
       ├── dry-run errors[]
       ├── formal thrown error
       ├── CLI JSON + exit policy
       ├── MCP error result
       └── strict artifact { code, phase, message }
```

Proposed modules：

```text
src/core/errors.js
  CoreOperationError
  CORE_ERROR_KINDS
  findErrorCause
  toCoreDiagnostic

src/core/error-policy.js
  composeErrorMappers
  createErrorBoundary
  preserveOwnedAbortReason
  promoteInfrastructureCause
  translateErrorCodes
  boundedUnclassifiedError

src/connection.js
  discoverCdpTargets
  CdpOperationError extends CoreOperationError

src/cli/router.js
  diagnostic serialization
  exitCodeForDiagnostic／resultExitCode

src/tools/_format.js
  same diagnostic projection for MCP
```

## Core principles

### 1. Normalize at the owning source

Raw `fetch`、CDP、filesystem、timer及runtime errors在最低且擁有operation semantics的boundary轉為structured
Core error。Higher-level domain code不得靠message、errno或code prefix重新猜測source type。

### 2. Abort is a carrier, not a kind

Process signal、owner deadline、caller cancellation、cascade cancellation及lease loss都可能透過AbortSignal傳遞，
但分別具有interrupt、cdp、conflict或原始primary error等不同語意。Controller必須盡可能使用
`abort(normalizedReason)`；receiver優先保留typed reason。

### 3. Source semantics precede cause promotion

Raw filesystem／transport event先由source owner依operation語意正規化。Higher-level mapper只提升已正規化的
`cdp`／generic `filesystem` cause，不直接從raw `ENOENT`或message推論。

### 4. Domain translation is explicit

Domain wrapper不得把transport、filesystem、interrupt或artifact failure轉成identity／validation。只有已知且由
該domain擁有的semantic code可透過exact map翻譯。

### 5. One boundary, two runtime projections

同一個boundary同時提供：

```js
boundary.error(error)       // formal throw path
boundary.diagnostic(error)  // dry-run aggregation path
```

兩者必須產生相同code、kind、phase、stage、message及retry semantics。

### 6. Presentation does not classify

CLI與MCP只做safe projection及delivery。Exit policy讀取kind／explicit signal exit code，不讀message。

### 7. Persisted artifacts stay stable

`run.json.error`、manifest error及Symbol error仍保存strict `{ code, phase, message }`。讀取artifact時由
domain-owned exact code map恢復runtime kind；不使用prefix／substring，因此不需升artifact v2／v3／v4 schema。

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

`kind`描述錯誤類別，`code`描述穩定的具體contract。Unknown raw error使用
`CORE_UNCLASSIFIED_ERROR / internal`，保留bounded safe root-cause message，不假裝成domain error。

完整欄位與precedence見[`ERROR_CONTRACT.md`](./ERROR_CONTRACT.md)。

## Migration strategy

採incremental vertical slices，避免big-bang rewrite：

1. 建立shared contract、mappers、boundaries及parity tests。
2. 統一CDP target discovery與Abort ownership，移除`core/tab.js` direct raw fetch。
3. 在owned artifact boundaries依operation semantics分類artifact／conflict／filesystem。
4. 遷移Strategy Run／Resume／Extend，修正motivating failure。
5. 讓CLI與MCP使用相同diagnostic projection及kind-based exit policy。
6. 依inventory逐批遷移其餘Core modules並移除message heuristics。

Migration期間，legacy `CoreOperationError`可暫時沒有kind；但任何進入presentation的normalized error都必須有
kind。Compatibility mapper以domain-owned exact code map補齊kind，無法識別時才使用
`CORE_UNCLASSIFIED_ERROR / internal`。Constructor不得以`kind = internal`靜默掩蓋未遷移call site。

## In scope

- Normalized `CoreOperationError` required kind及明確field ownership。
- Owner-aware Abort／process signal normalization。
- Composable pure error mappers and boundary factory。
- CDP target discovery single authority。
- Owned artifact／conflict／filesystem source classification。
- Strategy Run／Resume／Extend dry-run/formal parity。
- CLI／MCP diagnostic projection parity與完整`0/1/2/130/143` exit matrix。
- Persisted error exact-code kind rehydration。
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
- [ ] `kind`、`phase`、`stage`符合field responsibility，CDP failure可同時保留domain phase與source stage。
- [ ] SIGINT、SIGTERM、owner timeout、caller cancel及cascade abort不因共同使用AbortSignal而混淆。
- [ ] Required artifact ENOENT、output collision及generic filesystem failure依operation semantics分類。
- [ ] Dry-run diagnostic與formal thrown path對相同cause產生相同contract。
- [ ] CLI及MCP對同一Core error輸出相同code、kind、phase、stage、message、retryable。
- [ ] CLI exit code不再依message regex判定CDP failure，aggregated result遵守固定exit policy。
- [ ] Unknown fallback保留bounded safe root-cause message並使用`CORE_UNCLASSIFIED_ERROR / internal`。
- [ ] Cause-chain traversal有fixed bound／cycle protection且不觸發unowned getter。
- [ ] Existing public codes、v2／v3／v4 Resume及persisted artifact schemas無regression。
- [ ] Node 22／24 unit、lint、durable、pack及targeted fault matrix通過。

## Tasks

| ID | Task | Status | Depends on |
| --- | --- | --- | --- |
| [TASK-001](./TASK-001-error-contract-combinators.md) | Shared Error Contract and Combinators | `todo` | Current `CoreOperationError` |
| [TASK-002](./TASK-002-infrastructure-normalization.md) | Source Boundary and Abort Normalization | `todo` | TASK-001 |
| [TASK-003](./TASK-003-domain-presentation-integration.md) | Domain Boundaries and Presentation Parity | `todo` | TASK-002 |
| [TASK-004](./TASK-004-regression-migration-delivery.md) | Regression, Migration and Delivery | `todo` | TASK-003 |

Detailed decisions見[`DECISIONS.md`](./DECISIONS.md)，low-level design見[`LLD.md`](./LLD.md)。
