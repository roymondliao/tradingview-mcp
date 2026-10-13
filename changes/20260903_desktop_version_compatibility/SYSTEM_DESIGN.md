# Desktop Compatibility — System Design

Design date: 2026-10-13

Status: design documented; implementation not started.

## 1. Confirmed decisions

本設計採用使用者確認的 launcher-first 模式：

1. 受控 launch 入口在 CDP ready 後取得正在執行的 Desktop version，並更新 home 下的紀錄。
2. 一般 Desktop-dependent `tv command` 只讀本地紀錄；不查 Desktop version、不 probe core components、不自動執行檢測。
3. 本地狀態通過時直接執行；其他狀態顯示 warning 後仍執行原 command。Warning 不改變原 command 的 stdout schema 或 exit code。
4. 使用者明確執行 `tv compatibility check`；只有符合完整通過條件的結果才可更新 `passed`。
5. 第一版沒有 TTL、背景輪詢、過期自動檢測，也沒有每次 command 的 process/session fingerprint 檢查。
6. 狀態與報告存於 `~/.tradingview-mcp/compatibility/`，與 cwd、repo checkout 無關。檢測程式仍隨 repo／npm package 發布。

本文件定義系統責任、執行流程、report schema 與結果判定；[README](./README.md#required-validation-matrix) 定義檢測清單及逐項通過條件；[LLD](./LLD.md) 定義 module/store/CLI 介面與實作順序。

## 2. Assumption and accepted limitation

使用者透過 repo 提供的 launch scripts 或 `tv launch` 啟動帶 CDP 的 Desktop。直接執行自訂啟動命令、繞過 launcher 升版重啟而沿用舊紀錄，是本版明確接受的 edge case。

一般 command 不會驗證紀錄是否仍代表實際執行中的 Desktop。即使加 TTL，也無法完全排除該 edge case；本版不因此引入額外即時查詢。手動 compatibility check 一律重新取得 live version，可修正繞過 launcher 後的狀態。

同一 Desktop version 內的頁面 runtime／遠端服務變更亦不會由版本提示自動發現。既有 command 的 Target／Pane ownership、mutation readback、Report freshness、snapshot consistency、timeout 與 structured errors 必須保留；`passed` 不授權跳過它們。

## 3. Why the entry point is launch

目前 macOS／Linux／Windows BAT scripts 已輪詢 `/json/version`；`src/core/health.js` 的 `launch()` 也已取得相同回應。版本比對可重用成功的 response，不必再做一次 HTTP request。Windows VBS 尚未等待 CDP，必須接入共用 observer。

2026-10-13 本機 exploratory benchmark：macOS、Desktop 3.4.1、Node 26.5.1，30 次新 HTTP 連線查 `/json/version`、解析版本、讀取暫存目錄代表性 JSON 並比對；median 1.57 ms、P95 4.10 ms、首次／最大 6.46 ms。這不是正式 Gate 證據、跨平台 SLA 或 Node 22 驗證。選擇 launcher-first 是責任與使用流程的決定，不是認定版本查詢很昂貴。

實測 User-Agent 同時提供 `TradingView/3.4.1` 與 `TVDesktop/3.4.1`；`Browser` 是 Chromium version，不能用來冒充 Desktop version。

## 4. Architecture and responsibilities

```text
Launch scripts / tv launch / existing MCP launch
  → shared version parser + launch observer
  → home state store

tv command router
  → local-only advisory reader
  → stderr warning, if needed
  → existing command handler and runtime guards

tv compatibility check (explicit)
  → live environment / fixture preflight
  → versioned capability check registry
  → Core adapters + controlled restore coordinator
  → classifier + sanitized report
  → atomic report publication
  → conditional state update
```

| Component | Responsibility | Must not do |
| --- | --- | --- |
| Launch observer | Read live version at launch; reconcile matching evidence; persist observation | Run full checks or infer compatibility from CDP availability |
| Command advisory | Read small local state; validate its schema and checker identity; render one warning | Network/CDP calls, process inspection, auto-repair writes, automatic checks |
| Manual checker | Verify observable contracts; identify blocked prerequisites; restore mutations | Treat method existence or `success: true` alone as evidence |
| State store | Keep endpoint-specific observations, effective status and report references | Mark a newly observed version as verified |
| Report store | Preserve versioned, bounded, sanitized evidence | Store credentials, unrestricted runtime dumps or complete private Pine source |

`tv launch` 和 scripts 共用 parser／state transition logic；shell 只負責啟動與轉交資料。一般 MCP tools 不新增 CLI stderr advisory；既有 MCP launch 透過 shared Core 更新紀錄，並在 tool result 呈現需要的 warning。

## 5. Execution flows

### 5.1 Launch

1. 在啟動／重啟前將該 endpoint 的 active observation 標為 pending，保留歷史報告，避免啟動失敗後仍顯示先前 `passed`。
2. 沿用既有平台啟動流程，等待 CDP。
3. 成功 response 提供 exact Desktop version、Electron／Chromium／CDP metadata；以這份 response 建立 observation。
4. 相同 compatibility identity 且有效證據為 passed，保留 passed；相同 identity 的失敗／blocked 不因重啟而清除。
5. 新 identity 設為 unchecked；無法取得版本設為 blocked，不猜測為舊版。
6. Atomic 更新 home state；未通過則輸出手動檢測提示。版本提醒不撤銷 Desktop 啟動，也不自動關閉它。

所有提供的 launch 入口都必須完成整合，不能只改 macOS script。Node/helper 缺失或 home 無法寫入時，明確回報 compatibility bookkeeping 未完成，不宣稱版本已登錄；仍可能有已啟動的 Desktop。

### 5.2 Normal command

在 router 完成 command/subcommand 解析與 help 分流後、handler 執行前，讀取目前 endpoint 的 state。

- `passed` 且 version binding、schema、checker/adapter revision 都符合：無提示。
- 其他狀態或紀錄缺失／損壞／不可讀：一則 bounded stderr warning，提示 `tv compatibility check`；繼續原 command。
- `--help`、`--version`、純本地／不依賴 Desktop 的 commands、`launch` 與 `compatibility` 自身不走 advisory。
- 同一個 invocation 最多提示一次；不同 invocation 若仍未通過，仍各自提示。不做 suppression TTL。
- command 僅讀 state，不建立 home 目錄、不修改檢測狀態；串流 command 只在開始時提示。

`strategy run --dry-run` 等仍依賴 Desktop 的讀取命令也須提示；不能把所有 dry-run 都視為純本地。

### 5.3 Manual check

1. 取得 live version，與本地紀錄重新 reconcile；不依賴 launcher 的舊觀察值。
2. 固定 environment identity、observation generation、fixture 與實作 revision。
3. 執行 profile 中的檢查；controlled profile 包含 read-only 階段。
4. Controlled mutation 前記錄 restore context；失敗／中斷也執行 cleanup 與 restore readback。
5. 結束前再次確認環境。Desktop 版本／session 改變或新的 launch observation 已取代本輪，不能寫入 passed。
6. 先發布完整 report，再更新指向該 report 的 state。檔案寫入失敗不回報登錄成功。

## 6. State versus report result

flag 是版本綁定的 `status`，不是獨立 `true/false`。Home state 可使用 `unchecked | checking | passed | failed | blocked`。

| Event | Effective state | Meaning |
| --- | --- | --- |
| 首次成功觀察或版本／checker identity 改變 | unchecked | 尚無目前 identity 的完整證據 |
| 相同 identity 再次 launch | 保留原狀態 | 重啟不是檢測 |
| Controlled check 開始 | checking | 不沿用舊 passed 作為本輪成功 |
| Read-only 成功 | 首次仍 unchecked；既有 passed 可保留 | `diagnostics_passed`，不建立完整證據，也不清除先前 failed／blocked |
| 確認 required runtime contract 不相容 | failed | 保留失敗 report |
| 環境／fixture 不足、restore 失敗、interrupted 或證據不足 | blocked | 無法完成認證，不推論為 Desktop breaking change |
| 所有適用 required Desktop assertions、restore/cleanup 通過 | passed | Report overall_status 為 compatible |

Passed report 與最新 diagnostic report 分開記錄。任何較新的 failure／blocked 都會停止舊 passed 的有效性；不可因歷史上曾通過而掩蓋目前問題。所有已確認 failure 保留於 report；overall_status precedence 與 compatible 三值語意依下方 [Overall status and flag](#623-overall-status-and-flag)，restore failure 不可被成功資料讀取掩蓋。

Read-only 不執行的 controlled checks 必須顯示 `not_run`；不能列為 pass。Formal support matrix 只能引用完整 compatible report，且須另行完成 repo regression 並人工提交 completion evidence；user home 的狀態不是自動更新 repo 文件的指令。

### 6.1 Per-assertion result model

| status | Definition | Counts as pass? |
| --- | --- | --- |
| passed | 真正執行且 expected contract 成立 | 是 |
| failed | 前提成立，但 observable contract 不符，有 bounded evidence | 否 |
| blocked | 環境／fixture／dependency／未確定原因阻止驗證 | 否 |
| not_run | profile 未涵蓋、缺 opt-in、被中斷或尚未排程 | 否 |
| not_applicable | 已證實條件不適用，保留 reason/evidence | 從適用分母排除，不計為 passed |

不提供可以任意把 public surface 降級的 optional flag。v1 不用 `unsupported_optional` 作成功替代；若未來新增 genuinely optional capability，必須升 registry revision 並明確規格化。

每個 check 的 status 由 assertions 合成，優先 failed→blocked→not_run→passed；全部 assertions 都不適用才為 not_applicable。Report 的 complete 另確認所選 profile 的全部適用 assertions 都有終態，不能用 check 的單一 status 隱藏未執行的子項。

失敗紀錄必須區分：

- `failure_origin`：desktop_runtime / account_service / environment / fixture / dependency / checker / undetermined。
- `reason_code`：例如 METHOD_MISSING、RETURN_SHAPE_CHANGED、IDENTITY_MISMATCH、FRESH_REPORT_UNAVAILABLE、AUTH_REQUIRED、FIXTURE_MISSING、DEPENDENCY_BLOCKED、CHECK_TIMEOUT。
- `version_relation`：confirmed / suspected / not_established。單次新版失败預設 not_established；只有同 fixture/source 的可比 baseline 或明確 version-specific evidence 才能提高歸因，不能從「新版失敗」推論「新版造成」。

Timeout 本身不證明 API 缺失。以同 context bounded retry 一次仍無法排除 loading/network 時，記為 blocked/undetermined，而非冒充已確認 incompatible。

### 6.2 Report contract

完整 machine-readable JSON 永遠寫入 home reports；stdout/stderr 僅放 bounded summary，沿用既有 CLI success/error routing。`--output` 是額外副本。報告至少回答：版本是什麼、哪些能力通過、哪些失敗/未測、影響哪些入口、是否恢复、是否更新 flag、下一步是什麼。

#### 6.2.1 Top-level fields

| Field | Required content |
| --- | --- |
| schema_version / registry_revision / checker_revision / adapter_revision | 各自 versioned，保證可解讀結果與 scope |
| run_id / profile / scope | 唯一 ID；read-only 或 controlled；applicable_desktop_contracts |
| started_at / completed_at / duration_ms | UTC ISO＋elapsed；不是 TTL |
| environment | exact Desktop/source、Electron/Chromium/Protocol、OS/arch、Node、endpoint、repo commit/source fingerprint |
| baseline | comparable report reference、已知通過版本，或 null；無 baseline 不杜撰 |
| execution_status | completed / interrupted / checker_error，與 contract outcome 分開 |
| overall_status / compatible | 下節 enum；compatible 使用 true/false/null 三值 |
| components[] | 六個 core 與 feature groups 的 ID、read_status、controlled_status、full_status、check_ids、affected capabilities |
| checks[] | 所有 registry checks 都列出，含沒執行的 checks/assertions |
| coverage | selected_profile_complete、full_contract_complete、required/conditional exclusions、缺少 assertion IDs |
| summary | check_counts 與 assertion_counts 分開，每組含 total/passed/failed/blocked/not_run/not_applicable |
| impacted_surfaces | cli[] / mcp[]，由 registry mapping 產生；直接與 dependency 影響分開，不重複跑 wrapper |
| restore / cleanup | attempted、status、verified fields、test-owned resources pending、bounded recovery action |
| baseline_comparison | new_failures / recovered / unchanged / not_comparable；只有 profile/registry/fixture 可比才比較 |
| promotion | eligible、target_status、reason；描述可否升級 home flag，不是已寫入的證明 |
| next_steps | action code、check IDs、可執行指令模板或需要的 fixture；不建議盲目重跑 mutation |
| sanitization | policy_revision、redacted fields、truncation flags |

計數定義：每個 check/assertion 恰有一個 status，五個 status counts 加總等於 total；dependency blocked 子項不算新的 root failure。`full_contract_complete` 要求全部適用 read/controlled assertions 已驗證通過；read-only 不可能為 true。Component 分別呈現 read/controlled/full 狀態，避免 read-only 成功時把整個 component 標為完整 passed；check aggregate 的 not_run 也不代表已完成的 read assertions 失敗。

#### 6.2.2 Check and assertion detail

每個 check 含 id、component、required_when、applicability/evidence、status、duration_ms、timeout_ms、dependencies、assertions、affected_surfaces。每個 assertion 含 id、stage、kind、status、provider、expected、observed、reason_code、failure_origin、blocked_by、error、repro 與安全 evidence。

下列為 `assertions[]` 的單項示意，不是實際檢測結果，也不是完整 report：

```json
{
  "id": "STRATEGY-001.read.report_shape",
  "stage": "read-only",
  "kind": "data",
  "status": "failed",
  "provider": "activeStrategySource.reportData",
  "expected": { "performance": "object", "trades": "array" },
  "observed": { "performance": "missing", "trades": "array" },
  "reason_code": "RETURN_SHAPE_CHANGED",
  "failure_origin": "desktop_runtime",
  "version_relation": "not_established",
  "blocked_by": [],
  "evidence": {
    "fixture_present": true,
    "active_strategy_matched": true,
    "status_type": 2,
    "attempts": 2
  },
  "error": null,
  "repro": {
    "command_template": "tv compatibility check --profile read-only --fixture <fixture.json>",
    "mutation": false
  }
}
```

`expected` 必須由當前 Core 實際使用的欄位生成；示意 shape 不可取代 adapter 的完整 schema。診斷不含完整 Pine source、cookies、tokens、完整帳號清單、交易明細或 unrestricted object；只留 type/key presence/count、必要 numeric invariant 與 run-local aliases。單項 evidence 上限 8 KiB、全 report 1 MiB；不得為了限長省略未通過的 status／assertion ID。

#### 6.2.3 Overall status and flag

先固定初始／最終 version/context，完成 bounded restore，再 aggregate；結果不是只看 `success: true`。

| overall_status | compatible | Home status for current identity |
| --- | --- | --- |
| compatible | true | passed，僅 controlled 且全適用 assertions pass、restore/cleanup 通過 |
| diagnostics_passed | null | 不建立新 passed；保留既有有效 passed 或原先未通過狀態 |
| incompatible | false | failed；至少一項已确认 runtime/service contract failure |
| environment_blocked | null | blocked |
| fixture_blocked | null | blocked |
| validation_blocked | null | blocked；缺必要 opt-in／coverage，或混合原因 |
| restore_failed | null（若另有 confirmed failure 則 false） | blocked，保留所有 contract failures |
| interrupted | null（若另有 confirmed failure 則 false） | blocked |
| checker_error | null（若另有 confirmed failure 則 false） | blocked；測試程式錯誤，不推論 Desktop 不相容 |

固定 aggregate precedence：interrupted/checker_error（依 execution_status）→restore_failed→confirmed failed→environment_blocked→fixture_blocked→validation_blocked→compatible/diagnostics_passed。較高優先狀態不能刪除較低優先的 root failures；`compatible=false` 表示已知至少一個真實 contract failure，null 表示沒有足夠證據下結論。

Read-only 的 controlled not_run 不算 profile failure；若所有適用 read assertions pass，為 diagnostics_passed。但 required read assertion blocked 不能輸出 diagnostics_passed。Controlled 的必要 opt-in 未提供是 validation_blocked，不能只執行方便的部分就 passed。

即使 Account API contract failed，overall 也只是「這組現有功能與目前環境不相容」；failure_origin/account_service 與 version_relation 必須說明不是已證明 Desktop 升版造成。

#### 6.2.4 Persistence result

Canonical report 必須先 atomic publish，才能 promote state；因此 report 的 `promotion.eligible` 是判定，不寫假的 `state_updated: true`。

CLI summary 在 state transaction 後另回傳 `report_path`、`state_update.status: updated | failed | superseded`、effective_status。Write failed 時保留已完成 report、非零 exit；superseded 不覆蓋較新 observation，回報需要針對目前 observation 重測。歷史 report 不為了修改 state_update 而反覆重寫。

### 6.3 User-facing summaries

以下都是規格示意，正式 CLI 使用 bounded JSON，不混入協定 stdout 以外的任意文字：

```text
Desktop 3.4.1 / read-only / diagnostics_passed
Core read assertions passed; controlled assertions not run.
Compatibility flag: unchecked (no full verification).
Next: run controlled check with the required fixture and Replay opt-in if applicable.
Report: ~/.tradingview-mcp/compatibility/reports/<run-id>.json
```

```text
Desktop 3.4.1 / controlled / incompatible
Root failure: STRATEGY-001.read.report_shape — performance field missing.
Affected: strategy trading-report, strategy_get_trading_report, related dependent surfaces.
Other read checks completed; dependent Strategy mutations not run.
Restore: passed. Compatibility flag: failed.
Version-related cause: not established.
```

```text
Desktop 3.4.1 / controlled / fixture_blocked
Missing: second test Chart tab and a Strategy fixture with enough trades.
CDP round-trip passed; remaining dependent assertions blocked.
Compatibility: undetermined. Compatibility flag: blocked.
Next: prepare named fixtures and rerun; do not report Desktop as incompatible.
```

## 7. Persistence and invalidation

```text
~/.tradingview-mcp/compatibility/
  state.json
  reports/<UTC timestamp>-<run UUID>.json
  locks/
```

以 `os.homedir()` 解析 home；Windows 亦使用使用者 home，不能寫成 repo-relative `~` 目錄。`state.json` 按 CDP endpoint 分開記錄；多 checkout 的 checker／adapter revision 不符合時，command 僅本地判定為 unchecked 並提醒。

Compatibility identity 包含 exact Desktop version、已觀察到的 Electron／Chromium／CDP identity、OS／architecture、Node major、checker revision、adapter revision。完整 report 另記錄 Node exact version、repo commit 與 source fingerprint；不是每次 CLI 都呼叫 Git 或 hash 全 repo。

不設定 `expires_at`。`observed_at`、`checked_at` 僅供追溯，不驅動重新檢測。版本取得成功只更新 observation；`verified_desktop_version` 只能來自完整通過的 report。

## 8. Core coverage and profiles

檢測清單與各 provider 的 read-only／controlled assertions 見 [README：Core component checks](./README.md#core-component-checks) 與 [Feature dependency checks](./README.md#feature-dependency-checks)。六個主要元件與功能依賴共用下列執行規則；MCP/CLI wrapper 和一般 repo tests 不納入 Desktop capability 判定。

### 8.1 Preconditions, stages and dependencies

ENV-001 收集 exact Desktop version/source、Electron/Chromium/Protocol、OS/arch、Node、endpoint、repo commit/source fingerprint、checker/adapter revision；這是可追溯 metadata 與前置條件，不是完整 compatibility proof。

固定執行順序：

```text
ENV → CDP → TARGET/CONTEXT → CHART → DATA/HISTORY → STUDY → STRATEGY
          └→ Account services
                    └→ UI/Editor/Graphics/Drawing/Replay (依各自 prerequisite)
```

Registry 表示真正的 dependencies：Account list 需要有效頁面與登入，但不需要 Strategy Report；STRATEGY 依賴 Study/Context/Data。Root failure 後停止依賴它的檢查，無關的 read-only probes 可繼續。Mutations 串行執行，前一步尚未 quiescent 不開始下一步。

同一 provider 的觀察可以共用，但必須屬於相同 context／generation；mutation 後不能沿用先前 readback。Profile 對 assertion 的規則：

- read-only：不修改 Desktop state；只執行 read assertions，所有 controlled assertions 明確 not_run。
- controlled：執行全部適用 read + controlled assertions；明確 fixture 與 opt-in 不足時 blocked/not_run，而非默認跳過。
- 所有 fixture prerequisites 在涉及 writes 前驗證；缺 fixture 的 check 被阻擋，不妨礙無關讀取檢查。
- Entitlement 要有可說明的 evidence 才能標 not_applicable；unknown entitlement 為 blocked。未開 panel、無測試資料、忘記 opt-in 不是 not_applicable。
- Report 認證範圍固定為 `applicable_desktop_contracts`，列出每一個 excluded capability；passed 只表示該環境的適用範圍，不宣稱所有訂閱權限下都相容。

## 9. Operational and delivery boundaries

- 所有 probe、lock acquisition、cleanup 與 restore 都有上限；timeout 不保證 page operation 自動取消，LLD 必須防止後續 mutation 與未完成操作重疊。
- 同一 endpoint 的 controlled checks 不可並行；一般 command 不取得相容性 lock，測試期間應使用專用 fixture，偵測 ownership drift 後停止。
- 不自動升降版、不自動修 runtime、不自動建立新 thread 或發布 support matrix。
- 本次交付僅為 System Design／LLD 與任務規格同步，未建立 home state、未修改 launch/CLI runtime、未執行 Live Gate。

## 10. Acceptance summary

1. Launch 登錄版本；同版有效 passed 可保留，異版為 unchecked，失敗不得沿用舊 passed。
2. 普通 command advisory 的測試證明沒有 network、CDP、process query 或 state write。
3. Missing／invalid／failed／blocked／checking 均 warning-only，command result 與 exit code 保持原有語意。
4. 手動檢測的成功、失敗、中斷與 restore failure 都有可追溯 report，且不能錯誤升級為 passed。
5. Read-only 通過不等於完整 compatible；適用 Desktop coverage／restore／cleanup 缺一不可；repo regression 另屬實作品質驗收。
6. Cross-platform launch、home path、atomic publication、concurrency 與舊版／新版 fixtures 完成 deterministic coverage。
