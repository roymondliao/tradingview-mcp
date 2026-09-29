# Strategy Durable Export Recovery — Design Decisions

Status: `approved`

本文件追蹤會改變 public contract、artifact recoverability 或 safety boundary 的設計決策。`accepted` 是後續 implementation contract；`evidence_pending` 表示設計已固定，但量化門檻需由實測補齊。

## Decision register

| ID | Topic | Status | Decision |
| --- | --- | --- | --- |
| D-001 | Durable Run Directory lifecycle | `accepted` | Preflight 後直接 exclusive-create canonical Run Directory；不再使用 random run-level staging。 |
| D-002 | Artifact schema version and migration | `accepted` | Formal Run artifacts升級為v2；Config維持v1；V1／unknown artifacts不可Resume且不做migration。 |
| D-003 | Durable identity and minimal state model | `accepted` | `run.json` 管 Run；Experiment `manifest.json` 管 Symbols；採最小狀態集合。 |
| D-004 | Per-Symbol atomic publish and commit ordering | `accepted` | Attempt-owned sibling staging → atomic rename → callback atomic-update manifest。 |
| D-005 | Manifest durability and progress source | `accepted` | 沿用現有 manifest；不新增 progress／checkpoint／result files。 |
| D-006 | Fixed retry policy | `accepted` | Code constants：每 invocation 最多 3 attempts，delays 為 1s、2s；User 不可設定。 |
| D-007 | Retry classifier and attempt semantics | `accepted` | Stable code allowlist；CDP／identity／artifact errors abort invocation，交由明確Resume rebind。 |
| D-008 | Resume identity validation and rebind | `accepted` | Stable Layout／Pane／Strategy／Inputs／Watchlist identity必須相同；target/tab/entity等runtime IDs可受控rebind。 |
| D-009 | Same-run Resume lifecycle | `accepted` | Resume 原地沿用同一 Run ID，只執行非 `succeeded` Symbols，不建立 continuation run。 |
| D-010 | `strategy resume` CLI and errors | `accepted` | Resume 是獨立 Core module／CLI，Run 不自動 Resume。 |
| D-011 | SIGINT／SIGTERM and abrupt crash semantics | `accepted` | First signal graceful abort/restore；second signal immediate exit；hard crash由下次Resume恢復。 |
| D-012 | Cross-process Run／Pane lease | `accepted` | OS temp lock directories、stable hashed keys、PID liveness與token-checked reclaim/release。 |
| D-013 | Stale attempt staging cleanup | `accepted` | 持有Run lease後，只清除非succeeded Symbol可證明ownership的staging／uncommitted final directory。 |
| D-014 | Benchmark and live acceptance thresholds | `evidence_pending` | 652 × 3 shape已確認；量化threshold由filesystem prototype baseline決定。 |
| D-015 | Optional `strategy status` command | `accepted` | 本Change不實作；未來如有操作需求再以相同local reader另開Change。 |

## Accepted decisions

### D-001 Durable Run Directory lifecycle

Decision:

- Dry-run／preflight 維持 read-only，不產生 artifacts。
- Read-only preflight 全部通過後，以 exclusive create 建立 `<output>/<run-id>`。
- 建立後立即寫入 `run.json`，status 為 `running`。
- 所有後續 durable state 直接寫入 canonical Run Directory，不再使用 `.run-id.<uuid>.staging` 之類的 run-level random staging。
- `strategy run` 發現 target Run Directory 已存在時仍回傳 `RUN_OUTPUT_EXISTS`。只有 `strategy resume` 可以開啟既有 Run。
- Run Directory 的存在不表示已完成；Consumer 必須讀取 `run.json.status`。

Rationale:

現有 artifact structure 已保存 config、Strategy、Watchlist、Experiments 與 Symbols 所需 identity。直接建立 canonical directory，才能在 process crash 後保留已完成 Symbols 與 manifest state，避免整個 random staging root 無法被正式 Resume。

Rejected alternatives:

- 整個 Run 完成後才 rename random staging root：中途 crash 無法提供正式 durable recovery point。
- 另建 hidden durable working root：增加第二套 lifecycle 與 discoverability 問題，現有結構已足夠。

Compatibility impact:

- `RUN_OUTPUT_EXISTS` collision guarantee 保持不變。
- V1「output directory 存在即 terminal」的假設不再成立，Reader 必須檢查 status。
- Artifact schema version／migration 由 D-002 決定。

Failure behavior:

- 可捕捉且無法恢復的 error 將 Run 轉為 `failed` 並保存 error message／code。
- Abrupt crash 無法執行 terminal write，Run 保留 `running`，由後續 Resume 判定。

Required tests:

- Preflight failure 不建立 Run Directory。
- Exclusive create collision 回傳 `RUN_OUTPUT_EXISTS` 且不修改既有 artifacts。
- 建立 `run.json` 後各 crash point 都可被 Resume 發現。

### D-003 Durable identity and minimal state model

Decision:

```text
run.json                         → Run-level authoritative status
experiments/<name>/manifest.json → Experiment and Symbol authoritative status
```

Run／Experiment states：

- `running`
- `succeeded`
- `failed`

Symbol states：

- implicit `pending`：frozen Watchlist 中存在，但尚未寫入 `manifest.json.symbols[]`
- `running`
- `retry_wait`
- `succeeded`
- `failed`
- `skipped`

Logical Symbol work identity 至少包含：

```text
run_id + experiment_id + watchlist_index + requested_symbol
```

Attempt number 是 execution identity，不改變 logical work identity。

State rules：

- Run 開始落地時就是 `running`，不新增 `prepared`、`resuming`、`interrupted` 或 `restoring`。
- 所有工作成功才轉為 `succeeded`；任何未恢復 terminal failure 轉為 `failed`。
- Resume 只跳過 `succeeded` Symbols；其他 Symbol states 都屬未完成工作。
- `failed` 表示該 Symbol 已嘗試但未成功；`skipped` 表示受 Run／Experiment-level abort 影響而未執行完成。
- Symbol folder presence 不是 status source。

Time metadata：

- 保留 `started_at`／`started_at_iso`。
- 使用 `updated_at`／`updated_at_iso` 記錄最近一次 durable update。
- 不新增 `completed_at`、`resume_count` 或 `last_resumed_at`。

Symbol error metadata：

```json
{
  "error": {
    "code": "SYMBOL_SWITCH_FAILED",
    "phase": "symbol_switch",
    "message": "..."
  },
  "attempt_count": 3
}
```

不保存 `retry_exhausted` 或 `retryable`。Status、`attempt_count` 與 `error` 已足夠描述結果；retry decision 屬 execution logic。

Rationale:

現有 artifacts 已具備完整 identity 與 per-Symbol state 的自然位置。最小狀態集合減少 invalid transitions，也避免將 invocation history 誤建模成 public lifecycle。

Rejected alternatives:

- 新增大量 Run states：增加 recovery branching，卻沒有提供額外決策價值。
- 以 Symbol folder 是否存在推測成功：無法處理 rename 後、manifest callback 前 crash 的 window。
- 保存 `retry_exhausted`／`retryable`：前者可由狀態與 attempts 得知，後者可能使 future Resume 依賴過期分類。

Compatibility impact:

- V1 `partial` terminal state不延續到artifact v2，且不提供migration／Resume。
- Existing field migration 與 schema version 仍待定。

Failure behavior:

- Manifest 表示 `succeeded` 但 artifacts 缺漏／不一致時視為 corruption，禁止 silent rerun。
- Crash 時最後一個 atomic manifest state 是唯一進度依據。

Required tests:

- 每個合法／非法 transition 的 deterministic tests。
- Duplicate symbols 與 safe-symbol collision 不得共用 logical identity。
- Manifest/artifact contradiction 回傳 structured corruption error。

### D-004 Per-Symbol atomic publish and commit ordering

Decision:

每個 attempt 使用 Experiment `symbols/` 下的 attempt-owned sibling staging：

```text
symbols/
├── .TWSE_u3A_2330.attempt-2.staging/
└── TWSE_u3A_2330/
```

成功 commit ordering：

```text
set manifest symbol = running
  → Report A
  → all Trading Data from offset 0
  → Report B
  → reconciliation
  → write and close all staging artifacts
  → atomic rename staging directory to final Symbol directory
  → success callback atomically sets manifest symbol = succeeded
```

Failure／retry ordering：

- Attempt error 且仍有本 invocation budget：callback 設為 `retry_wait`，完成 backoff 後進入下一 attempt。
- Attempt error 且不再 retry：callback 設為 `failed`。
- Run／Experiment 在尚未處理某 Symbol 前 abort：可將該項標為 `skipped`，或維持 implicit `pending`；Resume 都視為未完成。

Crash window rules：

- Rename 前 crash：final folder 不存在，manifest 不是 `succeeded`；清理 owned staging 後重跑。
- Rename 後、success callback 前 crash：final folder 視為 uncommitted attempt；Resume 清理／isolate 後重跑。
- Success callback 後：manifest 是 authoritative succeeded record，Resume 跳過並先驗證必要 artifacts。

Rationale:

Same-filesystem directory rename 可避免同一 Symbol 的 `report`、`trades` 與 `reconciliation` 被部分發布；manifest callback 則提供明確 transaction commit point。

Known side effects:

- 同一 attempt 完成前需短暫占用 staging + final 所需 disk space。
- Crash 可能留下 staging 或 uncommitted final folder，需要 ownership-bounded cleanup。
- Directory rename 只保證同一 filesystem atomic；Writer 必須確保 staging 與 final 是 siblings。

Rejected alternatives:

- 直接逐檔寫入 final Symbol folder：Reader 可能看到 partial artifacts。
- 只看 final folder 存在即成功：無法證明 manifest commit 已完成。
- 建立 per-Symbol `result.json`：與 manifest 重複並產生雙重 source of truth。

Compatibility impact:

- Final successful Symbol artifact filenames 與 directory shape 不變。
- Internal staging naming 成為 cleanup／ownership contract 的一部分，但不是 public success evidence。

Failure behavior:

- Atomic rename 或 manifest update 失敗時不得回報 Symbol succeeded。
- Succeeded manifest entry 缺少 artifacts 時，回傳 `RUN_RESUME_ARTIFACT_INVALID` 或對應 artifact corruption error。

Required tests:

- 在 write、close、rename、callback 前後注入 crash。
- 驗證重啟後沒有混用 attempts，且只在 manifest committed 後跳過。
- 跨 filesystem／existing destination／cleanup failure tests。

### D-005 Manifest durability and progress source

Decision:

- 沿用每個 Experiment 的 `manifest.json` 保存 `requested_symbols`、`symbols[]`、summary、errors 與 artifact paths。
- 每次 Symbol state transition 都由 callback 更新 manifest，使用 same-directory temporary file + atomic replace。
- 不新增 `progress.jsonl`、`checkpoint.json`、`plan.json`、per-Symbol `result.json` 或 periodic compaction。
- `watchlist.json` 保持 frozen input order；implicit pending 可由 `requested_symbols`／Watchlist 與 manifest entries 的差集取得。

Rationale:

V1 manifest 已包含 Resume 所需資訊。第二套 event log／checkpoint 會增加 ordering、replay、compaction 與 source-of-truth conflicts。

Rejected alternatives:

- Append-only progress log + manifest rebuild：目前規模沒有證據支持其額外複雜度。
- Per-Symbol status file：與 Experiment manifest 重複。

Compatibility impact:

- Manifest 會由 terminal-only artifact 變成 running-time durable artifact；Reader 必須接受 atomic replacements。
- Exact schema version 由 D-002 決定。

Failure behavior:

- Atomic replace 前 crash 保留上一份 valid manifest。
- Temporary manifest file 不是 authoritative state，可由 ownership-bounded cleanup 移除。

Required tests:

- Manifest replacement crash／I/O error tests。
- 652 × 3 每次 transition rewrite 的 time、memory 與 file-size benchmark。

### D-006 Fixed retry policy

Decision:

Production constants：

```text
STRATEGY_SYMBOL_MAX_ATTEMPTS = 3
STRATEGY_SYMBOL_RETRY_DELAYS_MS = [1000, 2000]
```

- 1 次 initial attempt + 最多 2 次 retry。
- Run 與 Resume 共用同一 Symbol retry executor。
- 每次 Resume invocation 對未成功 Symbol 取得新的 3-attempt budget。
- Durable `attempt_count` 跨 invocations 累積；本 invocation budget 另在 memory 中計算。
- Run Config 不新增 `recovery`；CLI 不提供 retry overrides。
- Tests 可注入 fake delay／clock，但 production values 不可由 User 修改。

Rationale:

Retry 長期失敗通常代表 TradingView 或 runtime environment 問題。固定 bounded policy 可避免無限制等待，也避免不同 config 產生難以比較的 recovery behavior。

Rejected alternatives:

- User-configurable attempts／backoff：可能掩蓋環境故障並造成極長 execution。
- Resume 延續上次 invocation 剩餘 budget：無法達成 User 明確重新嘗試未完成工作的目的。
- 永久只允許總共 3 attempts：Crash／Desktop restart 後無法取得新的 recovery opportunity。

Compatibility impact:

- Config schema 不因 retry 增加欄位。
- Existing dry-run 不需要輸出 effective recovery config。

Failure behavior:

- Budget 結束後 Symbol 進入 `failed`，Run 跳到下一個 Symbol 繼續處理；全部工作走完後，只要仍有未成功 Symbol，Run 最終為 `failed`。
- 是否屬於可 retry error 由 D-007 classifier 決定。

Required tests:

- 0、1、2 retries 的 attempt count／delay sequence。
- Resume fresh budget + cumulative `attempt_count`。
- Fake timers 確保 tests 不等待 production delay。

### D-009 Same-run Resume lifecycle

Decision:

- Resume 直接更新原 Run Directory，不產生新 Run ID、output directory 或 parent／child continuation lineage。
- `run.json.status === succeeded` 時拒絕 Resume。
- `running`／`failed` Run 可進入 Resume eligibility validation。
- `succeeded` Experiment 整體跳過。
- `running`／`failed` Experiment 只排入 manifest 中不是 `succeeded` 的 Symbols。
- 尚未建立 manifest 的 Experiment，以 frozen Watchlist 執行完整 Experiment。
- Resume 沿用 persisted config、source、Watchlist Snapshot、Parameter Sets 與 experiment IDs。
- 取得 ownership 且通過 validation 後，將原 Run 與待繼續的 Experiment 更新為 `running` 並更新 `updated_at`；結束時再轉為 `succeeded` 或 `failed`，不新增 Resume 專屬 status。

Rationale:

Resume 的目的就是完成同一批預先確定的工作，而不是建立另一批 Run。原地更新 manifest 能保留已成功 evidence，也避免完整 Watchlist 重跑。

Rejected alternatives:

- 每次 Resume 產生新 Run ID：分散同一工作進度並增加 artifact reuse／lineage 複雜度。
- 重新執行整個 Watchlist：浪費成功成果，也提高長時間操作再次失敗的機率。
- `strategy run` 自動偵測 existing Run：模糊 collision 與 recovery intent。

Compatibility impact:

- Existing run collision 仍由 `strategy run` 保護。
- V1 terminal `partial`不可轉換或Resume；artifact v2才支援same-run Resume。

Failure behavior:

- Resume 再次失敗時保留同一 Run ID、最新 manifests 與 `failed` status，可再次明確執行 Resume。
- Crash 使 status 保留最後一次 atomic state，通常為 `running`。

Required tests:

- Mixed succeeded／failed／running／pending／skipped Symbols 的 Resume plan。
- Succeeded Experiment 不產生任何 TradingView mutation。
- Resume 不建立第二個 Run Directory。

### D-010 `strategy resume` CLI and errors

Decision:

Resume 是獨立 Core module 與 CLI：

```bash
npm run tv -- strategy resume --run-directory <output>/<run-id>
```

`strategy run` 不自動 Resume。Resume 先執行 local artifact validation，再取得 cross-process ownership，接著連接 TradingView 並做 identity validation／mutation。

Resume-specific error codes：

| Code | Trigger |
| --- | --- |
| `RUN_RESUME_NOT_FOUND` | Run Directory 或 `run.json` 不存在。 |
| `RUN_ALREADY_SUCCEEDED` | Run 已成功完成。 |
| `RUN_ALREADY_ACTIVE` | 另一個 process 正持有此 Run／Pane。 |
| `RUN_RESUME_VERSION_UNSUPPORTED` | Artifact schema 不支援 Resume。 |
| `RUN_RESUME_ARTIFACT_INVALID` | 必要 local artifacts 缺漏、malformed 或不一致。 |
| `RUN_RESUME_IDENTITY_MISMATCH` | Current stable identity 與 persisted Run 不一致。 |

Restore／execution errors 沿用既有 codes，包括 `PANE_CONTEXT_CHANGED`、`STRATEGY_INPUTS_CHANGED`、`PARAMETER_SET_RESTORE_FAILED`、`CHART_RESTORE_FAILED`、`CDP_*` 與 `STRATEGY_REPORT_UNAVAILABLE`。

Rationale:

Explicit Resume command 讓 User intent、collision safety 與 mutation ownership 清楚分離，也讓 Core module 可獨立測試。

Rejected alternatives:

- `strategy run` 自動判斷是否 Resume：相同 `run_id` 可能是誤操作，不應自動修改既有 evidence。
- 為既有 execution／restore failures 建立 Resume-prefixed duplicate codes：增加不必要的 error taxonomy。

Compatibility impact:

- 新增 CLI surface，不改變既有 `strategy run` flags。
- Bounded response與normal exit codes 0／1／2保持；graceful SIGINT／SIGTERM使用130／143，詳見LLD。

Failure behavior:

- Local validation 未通過不得連接／mutation TradingView。
- Identity validation 未通過不得修改 existing Symbol artifacts。

Required tests:

- Argument validation 與各 Resume-specific error mapping。
- Core／CLI separation、bounded stdout 與 exit code tests。
- Local invalid artifact path 不建立 CDP session。

## Additional accepted decisions

### D-002 Artifact schema version and migration

Decision:

- Run Config維持`schema_version: 1`。
- Formal Strategy Run的`run.json`、`experiment.json`與Experiment `manifest.json`升級為artifact schema version `2`。
- Trading Report／Data／Snapshot／Reconciliation維持既有schema versions。
- Resume只接受完整v2 artifacts；V1與unknown future version回傳`RUN_RESUME_VERSION_UNSUPPORTED`。
- 本Change不提供V1 migration或in-place rewrite。

Rationale:

V1有terminal-only root publication、`partial`與`completed_at`，無法證明中途manifest是正式commit。將其解讀為durable state會產生false success／skip風險。

Rejected alternatives:

- 在schema v1內改變status與durability semantics：Reader無法區分舊、新contract。
- 自動migrate V1 partial run：沒有足夠evidence判斷哪些Symbol artifacts已正式commit。

Compatibility impact:

- Existing V1 artifacts仍保留且可人工讀取，但不可Resume。
- Existing `strategy trading-export`繼續產生其V1 artifacts，不受formal Run v2影響。

Failure behavior:

- Unsupported version在任何Desktop connection／artifact mutation前拒絕。

Required tests:

- V1、v2與unknown version loader tests。
- Resume不得改寫unsupported artifacts。

### D-007 Retry classifier and attempt semantics

Decision:

- Classifier固定回傳`retry_symbol|fail_symbol|abort_run`，使用stable error-code allowlist。
- Runtime calculation、switch、snapshot、pagination與reconciliation transient errors可retry。
- Invalid Symbol request不retry但可繼續其他Symbols。
- `CDP_*`、Pane／Inputs／Strategy identity drift、restore、schema、artifact I/O與unknown errors abort本invocation。
- CDP connection module既有bounded reconnect先執行；若仍失敗，不在durable Symbol attempt內切換active target，交由明確Resume re-resolve。
- Backoff可由AbortSignal取消。

完整allowlist見[`LLD.md`](./LLD.md#classifier)。

Rationale:

只有完整fresh Symbol workflow能安全retry。Connection／identity／storage失效時繼續下一Symbol可能污染更多artifacts，因此採conservative abort。

Rejected alternatives:

- 依賴error的`retryable`boolean：既有fields不構成stable public policy。
- 所有errors都retry：會重複不可恢復的schema、identity或disk failures。
- Durable layer在同一attempt自動選擇另一個CDP target：可能控制錯誤Layout／Pane。

Compatibility impact:

- Existing errors可保留`retryable`給legacy callers，但durable executor不讀取。
- Production retry constants與classifier不接受Config／CLI override。

Failure behavior:

- Retry exhaustion把Symbol標為`failed`並繼續下一Symbol。
- `abort_run` 把 current Symbol 與 Run 標為 failed，停止新 mutation 並進入 restore。

Required tests:

- 每個allowlist code與unknown default的table-driven tests。
- Fresh attempts、cancelable backoff、new Resume budget與cumulative attempt count。

### D-008 Resume identity validation and rebind

Decision:

Stable fields必須相同：artifact/persisted config identity、Pine source hash、Saved Layout identity、Pane selector、Saved Strategy script/version/source、Candidate schema、Base／effective Input plans、Watchlist Snapshot與Parameter Set／Experiment fingerprints。Resume以`run.json.requested`為執行來源，不要求原Config file仍存在或未修改；config path/hash只作audit。

以下runtime fields可rebind：`target_id`、`tab_index`、CDP session與Pane `entity_id`。Entity只可在同一resolved Pane有恰好一個matching `script_id + version` Strategy且Input schema一致時rebind。Current Symbol／timeframe成為本次Resume restore baseline。

Current Inputs values只接受persisted Base或任一planned effective fingerprint；其他值視為external drift並拒絕Resume。Resume開始selected experiments前先restore persisted Base Inputs。

Rationale:

Desktop restart必然可能改變renderer target與entity IDs；將它們視為stable會使crash recovery失去作用。但Saved Layout、Pane、Strategy與Inputs intent不能漂移。

Rejected alternatives:

- 所有runtime IDs都必須相同：Desktop restart後無法Resume。
- 只按Layout name／Pane index繼續：不足以證明Strategy、source與Inputs ownership。
- 無條件把current Inputs改回Base：可能覆寫User在crash後的手動修改。

Compatibility impact:

- V2 artifacts需persist完整Base Inputs與planned Experiment identities。

Failure behavior:

- Stable mismatch回傳`RUN_RESUME_IDENTITY_MISMATCH`，不修改Chart或artifacts。

Required tests:

- 每個stable field drift rejection。
- target／tab／entity rebind acceptance。
- Base／planned Inputs acceptance與arbitrary Inputs rejection。

### D-011 Signal and crash semantics

Decision:

- CLI建立AbortController；Core接收signal，不自行註冊global process handlers。
- First SIGINT／SIGTERM不開始新attempt，立即cancel backoff，等待current bounded phase後restore Chart／Base Inputs，將Run標為`failed`與`RUN_INTERRUPTED`，release leases。
- Graceful exit codes為SIGINT `130`、SIGTERM `143`。
- Second signal立即exit，不再保證cleanup。
- SIGKILL／crash／power loss不保證state update；下次Resume使用最後atomic state與stale lease rules。

Rationale:

Detached cancellation可能讓CDP mutation在Core已release lease後繼續；因此current phase應依既有timeoutbounded完成，再restore。

Rejected alternatives:

- 第一個signal立即`process.exit()`：失去可達成的restore與state commit。
- 無限等待restore：CLI可能永遠無法停止。

Compatibility impact:

- CLI router需支援structured 130／143 exit code；normal 0／1／2不變。

Failure behavior:

- Restore失敗沿用`CHART_RESTORE_FAILED`並保留可Resume state。

Required tests:

- Signal during backoff、Symbol phase、manifest commit與restore。
- Second signal simulated abrupt exit recovery。

### D-012 Cross-process Run／Pane lease

Decision:

- 分開Run lease與Pane lease，固定 acquisition order Run → Pane、release order Pane → Run。
- Lease位於`os.tmpdir()/tradingview-mcp/strategy-leases`。
- Run key由canonical absolute Run Directory hash建立；New Run以nearest existing ancestor realpath加validated missing segments計算，Resume使用既有Run Directory realpath。Pane key由`stable layout ID + pane ID/index` hash建立。
- Atomic `mkdir`取得lease；owner metadata保存random token、PID、process start、Run、stable key、acquired／heartbeat time。
- Stale reclaim只在PID liveness回傳`ESRCH`時進行；`EPERM`視為live。不得只依mtime／heartbeat刪除。
- Release必須比對owner token。

Rationale:

現有`chartMutationMutex`只保護同一process。OS temp lease可跨CLI processes，stable key又能跨Desktop renderer restart。

Rejected alternatives:

- 只使用Run Directory lock：不同Runs仍可同時控制同一Pane。
- 只使用Pane lock：同一Run可被兩個Resume processes改寫。
- 只依mtime reclaim：slow operation可能被誤判stale。

Compatibility impact:

- Formal Run／Resume新增lock errors；legacy commands暫不納入cross-process lease。

Failure behavior:

- Live／無法安全判定的owner回傳`RUN_ALREADY_ACTIVE`，不等待。

Required tests:

- Duplicate Run、different Run same Pane、dead PID reclaim、PID live拒絕、token mismatch release。

### D-013 Stale attempt staging cleanup

Decision:

- Cleanup在每個non-succeeded Symbol attempt開始前執行。
- 必須已持有Run lease，並驗證path containment、Experiment name、safe Symbol segment與manifest status。
- 可清除該Symbol的matching staging directories及manifest未標示`succeeded`的final directory。
- Manifest已`succeeded`時禁止cleanup；artifacts不完整則回報corruption。
- Cleanup failure屬local artifact fatal error，abort本invocation。

Rationale:

Manifest callback是commit point；rename後callback前的final folder仍是uncommitted attempt，必須重跑而不是推測成功。

Rejected alternatives:

- Resume planning時glob刪除整個Run的staging：ownership scope過大。
- Folder存在即修復manifest為success：沒有證據證明callback前所有validation完成。

Compatibility impact:

- Attempt staging naming成為internal recovery contract，不是public success evidence。

Failure behavior:

- 無法證明ownership或無法刪除時回傳`RUN_RESUME_ARTIFACT_INVALID`／artifact I/O error。

Required tests:

- Staging-only、rename-before-callback、succeeded-final、path escape與cleanup I/O failures。

### D-014 Benchmark and live acceptance

Decision status: `evidence_pending`

Test shape已定案：

- Synthetic 652 Symbols × 3 Parameter Sets。
- Controlled live retry／crash／Resume scenarios。
- Exact-name`stock_all_list` expected 652的single-baseline endurance Run。
- Existing 448 × 3 result保留為multi-Parameter-Set live evidence。

量化time、memory、disk、manifest size與Resume planning thresholds必須先由filesystem prototype量測baseline，再更新本項；這是delivery evidence，不阻擋module implementation。

### D-015 Optional `strategy status` command

Decision:

本Change不新增public`strategy status`。Resume loader仍提供pure local read／summary functions供tests與未來重用；若實際操作證明需要status CLI，再另開Change。

Rationale:

目前`run.json`與manifests已可直接inspect；status不是Retry／Resume correctness的必要依賴。

Rejected alternatives:

- 與Resume一起增加CLI：擴大surface與測試範圍，沒有目前manual workflow需求證據。

Compatibility impact:

- 無public command變更；未來可向後相容新增。

Failure behavior:

- 不適用。

Required tests:

- Local reader保持無CDP依賴，供Resume與未來status重用。
