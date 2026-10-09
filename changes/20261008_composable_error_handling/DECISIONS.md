# Composable Error Handling — Design Decisions

Status: `proposed`

## Decision register

| ID | Topic | Status | Decision |
| --- | --- | --- | --- |
| D-001 | Architecture | `proposed` | 使用small pure mappers + composed boundaries，不建立global domain-aware handler。 |
| D-002 | Error carrier | `proposed` | `CoreOperationError`加入required internal `kind`，保留stable code／phase／cause。 |
| D-003 | Precedence | `proposed` | Interrupt及infrastructure cause優先於domain translation。 |
| D-004 | Source ownership | `proposed` | Raw transport/filesystem errors在source adapter正規化。 |
| D-005 | Dry-run parity | `proposed` | Formal throw與dry-run diagnostic由同一boundary產生。 |
| D-006 | Presentation | `proposed` | CLI／MCP只project及deliver，不重新分類錯誤。 |
| D-007 | Exit policy | `proposed` | CLI依kind/code決定exit code；移除message regex。 |
| D-008 | Public schema | `proposed` | Runtime diagnostics additive輸出`kind`；persisted artifact error不新增欄位。 |
| D-009 | Compatibility | `proposed` | Existing stable codes優先保留，採incremental migration。 |
| D-010 | Cause safety | `proposed` | Cause traversal bounded/cycle-safe，public projection不輸出cause或stack。 |

## D-001 Composition over global handling

Decision：

```js
const extensionIdentityBoundary = createErrorBoundary({
  phase: 'extension_identity',
  mappers: [
    preserveInterruptError,
    promoteInfrastructureCause,
    translateErrorCodes({
      RUN_RESUME_IDENTITY_MISMATCH: 'RUN_EXTENSION_IDENTITY_MISMATCH',
    }),
    boundedFallbackError('RUN_EXTENSION_IDENTITY_MISMATCH'),
  ],
});
```

每個mapper只識別一種policy；未知錯誤回傳`null`讓下一個mapper處理。

Rejected：

- 一個包含所有domain switch/case的global handler：ownership模糊且會持續膨脹。
- 每個code一個Error subclass：inheritance tree不利於cause promotion與cross-domain composition。
- 繼續catch後無條件wrap：會覆蓋CDP／filesystem／interrupt semantics。

## D-002 Error contract

Internal normalized error required fields：

```text
name
message
code
kind
phase or stage
retryable
cause (optional, private)
```

Optional bounded metadata維持現有entity／symbol／context／timeout／target fields。Unknown raw error必須經
bounded fallback轉為`kind: internal`，不能直接流入presentation。

## D-003 Precedence

Fixed order：

```text
interrupt
→ cause-chain infrastructure (cdp/filesystem)
→ already-normalized domain error
→ explicit domain translation
→ bounded fallback
```

Rationale：domain operation失敗不代表domain invariant失敗。例如「讀取Layout失敗」可能是CDP offline，
只有成功讀取後發現stable ID不同才是identity mismatch。

## D-004 Normalize at source

- `connection.js`是CDP discovery/connect/command transport errors的authority。
- `strategy-run-artifacts.js`／`artifacts.js`是filesystem artifact semantics的authority。
- `AbortSignal`在接收點立即轉為interrupt kind。
- `core/tab.js`不得直接使用unbounded/raw target-list fetch。

Source adapter保留low-level cause供internal tests/debugging，但public response只顯示bounded message。

## D-005 One boundary for dry-run and formal

Boundary API：

```js
boundary.normalize(error, context)
boundary.error(error, context)
boundary.diagnostic(error, context)
```

`error()`與`diagnostic()`都先呼叫同一`normalize()`。Dry-run不得再自行用fallback code覆蓋已知
infrastructure error；formal path不得產生另一套code。

## D-006 Presentation parity

`toCoreDiagnostic()`是CLI及MCP唯一safe projection primitive。CLI router與`tools/_format.js`可增加
delivery-specific fields，但相同Core error的code／kind／phase／message／retryable必須一致。

## D-007 Exit codes

```text
success                         0
interrupt SIGINT              130
interrupt SIGTERM             143
kind: cdp                       2
all other failures              1
```

Migration期間可讀existing `failure_kind: cdp_connection`，但不得再以message regex作永久fallback；完成
inventory後移除compatibility branch。

## D-008 Runtime versus persisted errors

Public runtime diagnostic可additive加入`kind`。Formal artifacts維持：

```json
{
  "code": "...",
  "phase": "...",
  "message": "..."
}
```

`sanitizeStrategyRunError()`明確project這三個fields，因此不需artifact v5。

## D-009 Incremental compatibility

- Existing documented codes不因kind rollout改名。
- Domain translation用explicit map，不使用prefix／substring猜測。
- 每個migration PR更新inventory與parity tests。
- 未遷移raw error進入fallback時回傳stable internal code並在test／telemetry seam可觀察，不假裝domain error。

## D-010 Cause traversal safety

`findErrorCause()`必須：

- identity-set cycle detection。
- Fixed maximum depth 16。
- Never invoke getters outside owned projected fields。
- Never serialize cause、stack或raw response。
- Preserve original error object without mutation。
