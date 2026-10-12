# Composable Error Handling — Design Decisions

Status: `accepted`

## Decision register

| ID | Topic | Status | Decision |
| --- | --- | --- | --- |
| D-001 | Architecture | `accepted` | 使用Origin／Source、Domain、Presentation／Persistence三層composed boundaries，不建立global domain-aware handler。 |
| D-002 | Field ownership | `accepted` | `code`描述具體contract、`kind`描述原因類別、`phase`描述domain workflow、`stage`描述source technical step。 |
| D-003 | Required kind | `accepted` | Kind對normalized presentation contract為required；legacy constructor migration期間不得默認為internal。 |
| D-004 | Source ownership | `accepted` | Raw event由最低且擁有operation semantics的source boundary正規化。 |
| D-005 | Abort ownership | `accepted` | AbortSignal是carrier；process signal、deadline、caller、cascade及lease owner依reason決定語意。 |
| D-006 | Precedence | `accepted` | Source semantic classification先於cause promotion；higher boundary只提升已正規化infrastructure cause。 |
| D-007 | Dry-run parity | `accepted` | Formal throw與dry-run diagnostic由同一boundary產生。 |
| D-008 | Presentation | `accepted` | CLI／MCP只project及deliver，不依message、prefix或class重新分類錯誤。 |
| D-009 | Exit policy | `accepted` | CLI完整public exit set為0／1／2／130／143；aggregated diagnostics使用固定kind policy。 |
| D-010 | Persisted schema | `accepted` | Runtime diagnostic有kind；artifact維持三欄，讀取時由domain exact code map恢復kind。 |
| D-011 | Unknown fallback | `accepted` | 使用`CORE_UNCLASSIFIED_ERROR / internal`並呈現bounded safe root-cause message，不假裝成domain error。 |
| D-012 | Compatibility | `accepted` | Existing stable codes優先保留，採incremental migration與reviewed inventory。 |
| D-013 | Cause safety | `accepted` | Cause traversal bounded／cycle-safe，不觸發unowned getter，public projection不輸出cause或stack。 |

## D-001 Three boundary layers

```text
Origin／Source boundary
  → code + kind + stage + message
Domain boundary
  → phase + preservation + explicit translation
Presentation／Persistence boundary
  → safe runtime diagnostic or strict artifact record
```

共用small pure mappers與boundary factory；各domain擁有自己的boundary definition及exact code maps。

Rejected：

- 一個包含所有domain switch/case的global handler：ownership模糊且會持續膨脹。
- 每個code一個Error subclass：inheritance tree不利於cause promotion與cross-domain composition。
- Catch後無條件wrap：會覆蓋CDP、filesystem、artifact、interrupt semantics。

## D-002 Field ownership

| Field | Owner and meaning |
| --- | --- |
| `code` | 產生該semantic error的source／domain；stable specific contract。 |
| `kind` | 產生normalized error的boundary；small cross-domain reason category。 |
| `phase` | Domain boundary；目前正在執行的workflow。 |
| `stage` | Source boundary；失敗的technical sub-step。 |
| `message` | Source／domain owner；bounded safe incident detail。 |
| `retryable` | Error owner的explicit policy；不從kind推導。 |
| `exit_code` | Presentation policy；只有POSIX signal保留130／143。 |

`phase`與`stage`可同時存在。`kind`不能表示位置，`phase`不能表示類別，`stage`不能取代domain phase。

Historical artifact的`phase: signal`保持read compatibility；新interrupt error應保留owning workflow phase，並使用
`stage: process_signal`及bounded `signal` metadata描述SIGINT／SIGTERM。

## D-003 Required kind and migration

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

`kind`從normalized boundary output開始required，而非在migration第一天對所有legacy constructor強制。Migration
期間：

1. Legacy `CoreOperationError`可以暫時沒有kind。
2. 新增或已遷移的call site必須explicit kind。
3. Compatibility mapper以domain exact code map補kind。
4. 無mapping的error進入`CORE_UNCLASSIFIED_ERROR / internal`。
5. Presentation不得接收missing／unknown kind。
6. Inventory清零後，constructor才全面強制kind。

Constructor不得使用`kind = internal`靜默錯分validation、artifact或conflict errors。

## D-004 Normalize at the owning source

Source boundary必須直接擁有raw operation、知道resource semantics，並能在不猜message的情況下指定code／kind／
stage。

- `connection.js`是CDP discovery/connect/command authority。
- `strategy-run-artifacts.js`／`artifacts.js`是durable artifact operation authority。
- Immutable output／lease owner將collision分類為conflict。
- Generic filesystem adapter只在沒有更精確semantics時使用filesystem。
- `core/tab.js`不得直接使用unbounded/raw target-list fetch。

Raw errno本身不決定kind。例如required artifact ENOENT是artifact，immutable Run EEXIST是conflict，generic
write EACCES才是filesystem。

## D-005 Abort and process signals

AbortSignal只傳遞停止，不直接代表interrupt：

| Owner／event | Normalized semantics |
| --- | --- |
| SIGINT | `RUN_INTERRUPTED / interrupt`, exit 130。 |
| SIGTERM | `RUN_INTERRUPTED / interrupt`, exit 143。 |
| Explicit caller cancel | `RUN_CANCELLED / interrupt`, exit 1。 |
| CDP deadline | `CDP_TIMEOUT / cdp`, exit 2。 |
| Other owned deadline | Owner-specific timeout code／kind, exit 1 unless another policy applies。 |
| Cascade cancellation | Preserve the primary normalized reason。 |
| Lease／ownership loss | Owned conflict code／kind, exit 1。 |
| Ownerless abort | `CORE_UNCLASSIFIED_ERROR / internal`, exit 1。 |

Controller應呼叫`abort(normalizedReason)`。Receiver先保存normalized `signal.reason`；只有owner知道deadline或
caller semantics時才建立新error。不得只以`error.name === 'AbortError'`分類。

## D-006 Precedence

Source normalization先執行；higher-level fixed order為：

```text
typed abort／process-signal reason
→ normalized or exact-known legacy cause-chain infrastructure (cdp/generic filesystem)
→ explicit exact-code domain translation
→ already-normalized domain error
→ normalize remaining exact-known legacy code
→ CORE_UNCLASSIFIED_ERROR fallback
```

Raw filesystem／network／AbortError不參與generic cause promotion。它們必須先由owner正規化。Domain operation失敗
不代表domain invariant失敗；例如讀取Layout失敗可能是CDP offline，只有成功讀取後發現stable ID不同才是
identity mismatch。Translation位於generic preserve之前，讓Extension可翻譯known Resume identity code；但前置
cause promotion會先保留更深層的CDP／filesystem semantics。

## D-007 One boundary for dry-run and formal

Boundary API：

```js
boundary.normalize(error, context)
boundary.error(error, context)
boundary.diagnostic(error, context)
```

`error()`與`diagnostic()`都呼叫同一`normalize()`。兩者的code／kind／phase／stage／message／retryable及safe
context必須一致。

## D-008 Presentation parity

`toCoreDiagnostic()`是CLI及MCP唯一safe projection primitive。Delivery adapter可將diagnostic `message`映射為
outer `error`以維持compatibility，但不得重列classification logic或safe-field allowlist。

## D-009 Exit policy

```text
success                                  0
non-POSIX cancellation                   1
validation/identity/filesystem/artifact/
conflict/internal failure                1
one or more reportable kind: cdp         2
interrupt SIGINT                       130
interrupt SIGTERM                      143
```

Aggregation順序：

1. Explicit 130／143 wins。
2. `success !== false` returns 0。
3. Top-level diagnostic或`errors[]`任一`kind: cdp` returns 2。
4. 其他failure returns 1。

Migration期間可讀existing `failure_kind: cdp_connection`，但不得再以message regex作fallback；inventory完成後
移除compatibility branch。

## D-010 Runtime versus persisted errors

Public runtime diagnostic可additive加入kind／stage等fields。Formal artifacts維持：

```json
{
  "code": "...",
  "phase": "...",
  "message": "..."
}
```

`sanitizeStrategyRunError()`明確project這三個fields，因此不需artifact v5。讀取後由Strategy-owned exact
code-to-kind map重建runtime error；不得依prefix或message猜測。未知persisted code保留原code／message，runtime
暫列`kind: internal`並進入migration observability，不修改disk artifact。

## D-011 Unknown fallback

所有known mappers decline時：

```json
{
  "code": "CORE_UNCLASSIFIED_ERROR",
  "kind": "internal",
  "phase": "<owning workflow>",
  "message": "<bounded safe deepest root-cause message>",
  "retryable": false
}
```

Fallback保留可安全公開的root-cause message，但不serialize cause、stack、raw response或arbitrary fields。Fallback
code不能使用identity／validation等semantic code。

## D-012 Incremental compatibility

- Existing documented codes不因kind rollout改名。
- Domain translation及persisted rehydration使用explicit exact maps，不使用prefix／substring猜測。
- 每批migration更新inventory與parity tests。
- Inventory可包含已review但延後遷移的module；本Feature的Strategy／CDP／presentation vertical slice必須完成。
- 未遷移raw error進入fallback時必須可在test／observability seam辨識，不得靜默視為完成。

## D-013 Cause traversal safety

`findErrorCause()`必須：

- Identity-set cycle detection。
- 最多檢查16個object nodes；第17個不讀取。
- 只讀normal Error／plain object own data-property `cause`，不觸發getter。
- 不serialize cause、stack或raw response。
- 不mutation original error。
