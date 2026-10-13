# Desktop Compatibility — Low-Level Design

Design date: 2026-10-13

Status: proposed implementation contract; no commands/modules below are implemented by this documentation change.

## 1. Scope and invariants

依 [System Design](./SYSTEM_DESIGN.md) 實作：launch 查 live version；普通 command local-only warning；user 明確執行 checker；home 保存版本、狀態與報告；沒有 TTL。

檢測清單以 [README](./README.md#required-validation-matrix) 為準；report 欄位與判定以 [System Design](./SYSTEM_DESIGN.md#62-report-contract) 為準。本文件不另外定義 MCP 專屬檢測或 repo regression 前置條件。

必要 invariants：

- `observed.desktop_version` 與 `verification.desktop_version` 分開，未檢測的 launch 不得建立 verification。
- `status === passed` 需要 verification identity 等於 observation identity，且完整 report 已成功發布。
- Home status 不取代現有 Core runtime guards；warning 不阻止 handler。
- 所有 state mutation 在 host Node 執行，page runtime 只做 bounded probes；page 不讀寫 home 或執行 shell。
- 下列 module names 為建議拆分，可合併檔案，但不混合 local-only reader 與 CDP probe 的依賴。

## 2. Proposed module map

| Module / integration point | Interface / responsibility |
| --- | --- |
| `src/core/compatibility/version.js` | `parseDesktopVersionResponse(info)`、`observeDesktopVersion({ endpoint, timeout_ms })` |
| `src/core/compatibility/identity.js` | schema/checker/adapter revisions、endpoint normalization、identity comparison；無 CDP side effects |
| `src/core/compatibility/store.js` | bounded state read、short transaction lock、atomic writes、report paths |
| `src/core/compatibility/advisory.js` | `readCompatibilityAdvisory({ endpoint, implementation, store })`；只依賴 local modules |
| `src/core/compatibility/launch.js` | `beginLaunchObservation()`、`recordLaunchObservation()`、`recordLaunchFailure()` |
| `src/core/compatibility/registry.js` | versioned checks、profile/stage、timeouts、preconditions、surface mapping |
| `src/core/compatibility/check.js` | `checkCompatibility(options)`、classification、bounded execution、restore coordinator |
| `src/core/compatibility/report.js` | report validation、sanitization、atomic publication、eligible verification builder |
| `src/cli/commands/compatibility.js` | `check`、`status` arguments/help；Core result presentation |
| `src/cli/router.js` | leaf command metadata 與 advisory hook；維持現有 error/exit policy |
| `src/core/health.js` | `launch()` lifecycle 接 observer；包含 `--no-kill` 的成功連線情境 |
| `scripts/compatibility-launch.js` | scripts 共用 Node bridge；begin/observe/fail，stdin 接 metadata，不接受 arbitrary page JS |

`src/cli/index.js` 註冊新的 compatibility commands。既有 `src/core/artifacts.js` 的 publication primitives 可重用；mutable state 的短交易鎖需另外提供，不能假設現有 artifact transaction 等於跨程序 state lock。

## 3. Version source and identity

### 3.1 CDP observation

- 讀 `http://<configured-host>:<configured-port>/json/version`，沿用 `TV_CDP_HOST/PORT`、`CDP_HOST/PORT` 與 defaults 的 precedence。
- Launch 已有成功 response 時直接傳入 parser。手動 check 開始／結束自行讀取；ordinary command 不得呼叫。
- HTTP success、JSON object、必要欄位、response size 都要驗證；單次 version request timeout 預設 2000 ms、response 上限 64 KiB。
- `User-Agent` 優先取完整 `TVDesktop/<version>` token，沒有時 fallback `TradingView/<version>`；兩者存在但不一致則 blocked，不任選一個。
- 保留 exact token，包括 suffix；不把不同 patch／pre-release 視為相同。Browser、Electron、Protocol 各自解析，不冒充 Desktop version。
- `desktop_version_source` 為 `cdp_user_agent_tvdesktop | cdp_user_agent_tradingview | explicit_cli`。
- Check 的 `--desktop-version` 僅在 live response 缺 Desktop token 時補入，report 標示人工來源；與可讀 live version 衝突時拒絕。Launch 無人工輸入則 blocked。
- 人工補入不建立 launcher 的自動 version capability；下次 launch 仍無法辨識時回到 blocked。手動來源只描述該次檢測，不是永久 override。

Parser unit fixtures 覆蓋兩 token 一致、僅一個、衝突、缺失、Chromium-only、非 JSON、HTTP failure、oversized body、timeout。不要保存完整原始 User-Agent／webSocketDebuggerUrl；保留必要 parsed fields 即可。

### 3.2 Matching rules

`endpoint_key` 由 normalized configured host + numeric port 產生；所有 launch helper 與 CLI 使用同一函式。受控 scripts 統一預設 `127.0.0.1`，不在 command 執行 DNS 查詢來猜 endpoint 等價性。

Compatibility identity：

```text
desktop_version, electron_version, chromium_version, protocol_version,
platform, architecture, node_major, checker_revision, adapter_revision
```

Missing nullable metadata 必須明確存 null；從已知值變成 null 不能等同既有已知 identity。State schema 使用整數版本；未知 schema 不靜默套用。

`checker_revision`／`adapter_revision` 是隨程式發布的本地常數，不在每次 command 執行 Git／source hashing。更改必要 registry、parser 或 Desktop adapter contract 時必須更新相應 revision，納入 review／regression checklist。手動 Check 時另計算涵蓋 adapters、CLI、checker、tests 與 dependency lockfile 的 source fingerprint，包含未提交變更；文件變更可排除。Fingerprint file set 本身也版本化。此機制無法偵測未遵循 revision bump 的開發中修改，開發者需手動 rerun Gate。

## 4. Home storage contract

Root 為 `path.join(os.homedir(), '.tradingview-mcp', 'compatibility')`；runtime 不提供 cwd-relative fallback。Tests 透過 `_deps` 注入暫存 home，不能污染真實使用者紀錄。

### 4.1 State schema v1

以下是示意；timestamp 與版本不是支援認證：

```json
{
  "schema_version": 1,
  "revision": 8,
  "endpoints": {
    "127.0.0.1:9222": {
      "observation_generation": "launch-or-check-uuid",
      "observed": {
        "desktop_version": "3.4.1",
        "desktop_version_source": "cdp_user_agent_tvdesktop",
        "electron_version": "41.7.1",
        "chromium_version": "146.0.7680.216",
        "protocol_version": "1.3",
        "platform": "darwin",
        "architecture": "arm64",
        "node_major": 22,
        "checker_revision": 1,
        "adapter_revision": 1,
        "observed_at": "2026-10-13T01:00:00.000Z"
      },
      "last_launch_checked_at": "2026-10-13T01:00:00.000Z",
      "status": "unchecked",
      "reason": "desktop_version_changed",
      "verification": null,
      "last_check": null,
      "active_check": null
    }
  }
}
```

- `verification`：完整 identity、`desktop_version`、`checked_at`、`report_path`、`report_sha256`、`source_fingerprint`、`scope: applicable_desktop_contracts` 與 evidence-backed exclusions；只有 compatible report 能建立。
- `last_check`：run ID、profile、overall_status、completed_at、report path；read-only 也會寫入，不能取代 verification。
- `active_check`：run ID、owner token、started_at、captured observation generation；僅檢測執行期間存在。
- `status`：unchecked/checking/passed/failed/blocked；`reason` 是 stable code，例如 `no_verification`、`checker_changed`、`fixture_missing`、`restore_failed`、`interrupted`。
- 新版本 observation 不攜帶舊版 verification 作為有效 pass；舊報告留在 reports。v1 不自動從歷史報告重建過去版本的 passed，降版後亦可重新檢測。
- 無檔案時 effective status 為 unchecked；corrupt/unreadable state 視為 blocked 並提示。普通 command 不修檔。
- Read cap 初始 256 KiB；超限視為無效紀錄，不做 unrestricted read。設定只針對 state，完整報告另設 bounded evidence limits。

### 4.2 Files and publication

目錄按平台可用能力使用 owner-only 權限（POSIX directory 0700、files 0600），時間存 UTC ISO。Reports 使用 timestamp + UUID 唯一檔名，不含使用者提供的 Layout／Script 名稱。

Write ordering：

1. 在同一 filesystem 的 temporary path 寫完整 report，驗證 schema，完成 atomic publish。
2. 取得短 state lock、重讀最新 state、比對 observation generation／owner token。
3. 保留其他 endpoints，更新目前 endpoint，使用 temporary sibling file + atomic rename。
4. State update 失敗時保留已發布 report，但結果為 `COMPATIBILITY_STATE_WRITE_FAILED`，不得宣稱 flag 已通過。

讀者不取寫鎖，只會讀到舊或新完整 JSON。Writer 不把整個正在執行的 checker 放在 state lock 內。Corrupt state 由明確 launch/check writer 保留帶 UUID 的備份後重建；不可丟失可恢復的原檔。

`--output` 是 home canonical report 的額外副本；先完成要求的副本出版再 promote state。Existing destination 無 `--force` 時拒絕；`--force` 不允許覆寫 state、lock、canonical report 路徑。Home 寫入失敗時不能只在 cwd 另存一份並宣稱成功。

## 5. Launch integration

### 5.1 Shared state transitions

`beginLaunchObservation({ endpoint })` 在 launch side effect 前建立新 generation、保存 previous observation/status 供同版 reconcile、暫時設 blocked/reason launch_pending。Launch-only bookkeeping 不執行 registry。

`recordLaunchObservation({ endpoint, generation, version_response })`：

- parser success 且 identity 與 previous 相同：恢復 previous effective status，保留未解決 failure；僅既有有效 verification 才能回到 passed。
- identity 不同：unchecked、verification null。
- parser failure：blocked/version_unavailable；保留 diagnostics，不採安裝檔版本 fallback。
- generation 已被較新的 launch/check 取代：不覆寫，回傳 superseded。

`recordLaunchFailure()` 清除 pending，維持 blocked；SIGKILL 留下 launch_pending 也不會被普通 command 視為 passed。

### 5.2 Platform entry points

| Entry | Required change |
| --- | --- |
| `launch_tv_debug_mac.sh` / Linux script | 將成功 `/json/version` response 保存並交給 Node helper stdin；helper path 相對 script directory，支援空白路徑；不重複查詢 |
| `launch_tv_debug.bat` | 使用 `%~dp0` 解析 helper；port 一致；bounded curl timeout、JSON 經檔案/stdin 傳入，不做 shell string interpolation |
| `launch_tv_debug.vbs` | 加入相同 begin/ready/observe 協定，可委派共用 helper 的 bounded wait；不只 sleep 1 秒後顯示 Launched |
| `src/core/health.js: launch()` | 重用 `_waitForCdp` 的 info；所有平台／MSIX fallback／no-kill 路徑同樣記錄 |

Shell launchers 需可用的 Node >=22 來使用共用 helper；啟動前 preflight，缺少依賴就以非零 exit 明確說明，不能靜默跳過版本紀錄。同版已知 failed／unchecked 是 advisory，不使成功 launch 變失敗；state 持久化失敗是 bookkeeping error，非零 exit 並說明 Desktop 可能已啟動，不自動 kill。

Core launch 透過回傳的 `compatibility` 摘要讓 CLI/MCP 各自呈現；Core 不直接寫 CLI stderr。既有 cdp_ready=false 行為附上 blocked compatibility，不因拿不到版本而虛構成功 observation。

## 6. CLI advisory integration

在 command registration 增加 leaf-level metadata：

```js
desktop_dependency: 'required' | 'none' | 'launch' | 'compatibility'
```

Parent metadata 可繼承，但 leaf override 必須明確。Registry completeness test 要求每個可執行 leaf 都有 resolved classification；新增 command 不得默認漏檢。

`router.execute` 接收 resolved command metadata，在 handler 前呼叫 local-only reader。現有 `resultExitCode`、`diagnosticExitCode` 與 `handleError` 不因 advisory 改變。

Reader steps：

1. 解析本地 configured endpoint，bounded read/parse state。
2. 驗證 schema、endpoint、status enum、observation/verification identity、local checker/adapter revision、Node major、OS/arch。
3. passed 但 binding 不完整則 effective unchecked；不讀 live version、不做 HTTP、CDP、Git 或 process liveness query。
4. 返回 `{ warn, code, status, observed_version, verified_version, next_command }`；router 以 JSON.stringify 編碼為 stderr 單行，最多 2 KiB，避免不可信 metadata 換行注入。

Warning code 統一 `COMPATIBILITY_CHECK_RECOMMENDED`，含 reason。讀取失敗本身不得讓正常 handler 被 exception 阻止。

```json
{"level":"warning","code":"COMPATIBILITY_CHECK_RECOMMENDED","status":"unchecked","reason":"desktop_version_changed","observed_version":"3.4.1","next_command":"tv compatibility check"}
```

`help/version` 在 hook 前返回；`pine analyze`、不依賴 Desktop 的 `pine check` 等標 none；`strategy run/extend --dry-run` 仍 required。`compatibility status/check`、launch 豁免，避免 checker 對自己發 warning。一般 command 不改 home state，即使 runtime 失敗也由原 error handler 回報，由 user 決定執行 check。

## 7. Manual CLI contract

所有以下介面都是本 Change 的 target commands：

```bash
tv compatibility status
tv compatibility check
tv compatibility check --profile read-only
tv compatibility check --profile controlled --fixture /absolute/path/fixture.json
tv compatibility check --profile controlled --fixture /absolute/path/fixture.json --include-replay
```

| Option | Contract |
| --- | --- |
| `--profile` | read-only default；controlled 包含 read-only probes 與受控操作 |
| `--fixture` | controlled 必填；read-only 可選，用於指定已知資料斷言，不能啟用／切换 UI |
| `--desktop-version` | 僅 token unavailable 時明確補入；live mismatch 為 validation error |
| `--include-replay` | opt-in Replay controlled checks，使用独立 fixture |
| `--include-replay-trading` | 另行 opt-in 且要求 include-replay；只操作 test-owned executions |
| `--output` / `--force` | 額外 report 副本與明確覆寫；home canonical report 永遠保存 |

`status` 完全 local-only，返回 effective state、last observed version/time、last check/report reference；欄位名稱不宣稱是「目前 live version」。讀取有效 state 成功即 exit 0，即使 status 未通過；missing/invalid 仍回傳有界狀態說明，不探測 Desktop。

`check` 不需要 `--refresh`，每次都是新檢測。讀取 profile 全部適用 checks 通過時 `success: true, overall_status: diagnostics_passed`，exit 0，但不能建立完整 verification。Controlled 執行完成卻缺必要 Desktop assertion／opt-in，回傳 `validation_blocked`，exit 1，清楚列出下一步，不假裝 compatible。

其他結果沿用 router：compatible exit 0；incompatible/fixture/validation/restore/state-write failure exit 1；CDP 連線失敗 kind=cdp、exit 2；SIGINT/SIGTERM 為 130/143。check 摘要帶 success、overall_status、effective_status、report_path、counts、next_steps；stdout/stderr 遵循既有 success/error routing。

### 7.1 Fixture contract

Fixture JSON schema v1 以明確欄位提供 target selector（Saved Layout ID 或可唯一解析的 Layout）、pane_index、known symbols 至少兩個、timeframes、Study／Strategy selectors、named Watchlist selector、一項可修改的 Study Input、獨立 replay target（若 opt-in），以及兩個 Chart tabs／多 Pane fixture。不得以「第一個 Tab／Strategy」補齊缺漏。核心 fixture 欄位示意如下（尚不足以完成所有 feature assertions），IDs 與 names 均需由 user 填入專用測試環境的實際值：

```json
{
  "schema_version": 1,
  "target": { "saved_layout_id": "test-layout-id", "pane_index": 0 },
  "symbols": ["NASDAQ:AAPL", "NASDAQ:MSFT"],
  "timeframes": ["D", "60"],
  "indicator": { "entity_id": "test-indicator-entity" },
  "strategy": { "entity_id": "test-strategy-entity", "script_id": "USER;test-script" },
  "watchlist": { "name": "Compatibility Fixture" },
  "input_mutation": { "name": "Length", "value": 20 }
}
```

`target` 恰有一個 Layout selector（`saved_layout_id` 或 exact `layout_name`）且 pane_index 為非負整數；Strategy 必須同時驗證 Entity ownership 與 script identity。Unknown fields、缺少／不唯一 Input names 都在 mutation 前拒絕。Replay 選用 `replay_target`，沿用 target schema 且指定獨立測試資源。完整 fixture 另指定第二個測試 Tab selector、可恢復的另一 Pane、graphics/editor 測試資產、允許修改的 test Watchlist 與策略資料分支；缺少哪一項只阻擋對應 assertion，細節見 [README：Core component checks](./README.md#core-component-checks) 與 [Feature dependency checks](./README.md#feature-dependency-checks)。不要求準備 Resume Run directory。

Controlled 使用 disposable／專用 Layout 與測試資產。Account script mutation 只針對本輪建立的 Script ID；不得修改 user 原有 source。紀錄 created entity/drawing/alert IDs 作 cleanup ledger，失敗僅刪除 ledger 內資產。報告存 bounded identity／hash，不存完整 fixture 中的 private source。

### 7.2 Project tests are separate

User 執行 compatibility check 不需要 `--regression-report` 或額外 runner，也不在報告列出 lint/unit/MCP wrapper 作為 Desktop 能力。原提案中的專用 regression producer/consumer 不實作。

維護者修改 checker/adapter 後仍使用 package.json 的 unit、CLI、error-policy、integration/E2E 與 lint 指令驗證交付；重複的 suite 不需重跑。Repo delivery evidence 與 Desktop report 分開，不能以 local mock tests 成功代替 Live contract，也不能因 user 沒跑 npm tests 而阻擋 Desktop 相容性判定。

## 8. Check registry and execution

每個 check 定義：

```js
{
  id: 'STRATEGY-001',
  required_when: 'always',
  surfaces: ['strategy active', 'strategy trading-report', 'strategy trading-data'],
  stages: ['read-only', 'controlled'],
  depends_on: ['CONTEXT-001', 'STUDY-001'],
  preconditions: ['account_strategy_with_trades'],
  timeout_ms: 60000,
  evidence_limit_bytes: 8192,
  readOnlyProbe,
  controlledProbe,
}
```

Sub-assertions 分別記錄 passed/failed/blocked/not_run/not_applicable。Complete certification 要求所有適用 required stages 通過；僅 method presence 不足。依賴失敗導致的 blocked 應指向 root check，避免生成多個誤導的 incompatibility。

初始 budgets：version request 2s；read-only check 15s；一般 controlled check 60s；restore 每階段 20s；全輪 read-only 120s、controlled 900s，另保留總 restore budget 60s。以上為設計初值，實作須以 fixture 實測調整並記錄，不無限 retry。

Timeout 不能只 `Promise.race` 後繼續下一個 mutation：傳遞 AbortSignal、停止排程、確認先前 operation 已結束才 restore。若無法取消 page-side mutation／確認 quiescence，停止後續 writes，標 restore blocked 並給 user recovery instructions，不能邊跑舊操作邊恢復。

### 8.1 Required assertion mapping

完整 mapping／assertion 定義以 [README：Core component checks](./README.md#core-component-checks) 為準，registry 使用以下 IDs：

| Component | IDs |
| --- | --- |
| Environment | ENV-001 |
| CDP transport/Runtime | CDP-001 |
| Target/Layout/Pane | TARGET-001、CONTEXT-001 |
| Chart state/mutations | CHART-001 |
| Main Series/history | DATA-001、HISTORY-001 |
| Study Entity/Inputs | STUDY-001 |
| Strategy lifecycle/report | STRATEGY-001 |
| Account services | PINE-ACCOUNT-001、WATCHLIST-001、ALERT-001 |
| Editor/UI | PINE-001、UI-001 |
| Feature runtime | GRAPHICS-001、DRAWING-001、REPLAY-001 |

Leaf surface inventory 包含 CLI commands 與已註冊 MCP tools、legacy aliases、conditional depth 與 run/resume/extend 的 Desktop providers；以本地 coverage test 確認完整映射，不列為 Live check。並非每個 surface 都有獨立檢查：共同 provider 只執行一次，產生多入口 impact mapping。

不再使用 SURFACE/AUTOMATION/RESUME/STREAM/OUTPUT/REGRESSION checks；其 repo tests 保留。Run/Resume/Extend 依賴的定位、Study identity、freshness 已由對應底層 checks 驗證，不把整條 orchestration 放進 Desktop report。

## 9. Result/report and promotion

Report schema v1 至少包含：

```text
run_id, schema_version, checker_revision, adapter_revision
started_at, completed_at, profile, scope, environment, source_fingerprint
desktop_version_source, observation_generation
execution_status, overall_status, compatible, components[], checks[], coverage, summary
impacted_surfaces, baseline_comparison, promotion
restore, cleanup, sanitization, next_steps
```

`checks[]` 包含 id、required_when、applicability、assertions、status、duration_ms、timeout_ms、provider path、expected/observed bounded shape、normalized error、precondition/exclusion reason。單項 evidence 8 KiB、全 report 預設上限 1 MiB；超限截斷 diagnostics 並標記 truncation，不截掉 check status／required coverage。

overall_status、compatible 三值、失敗來源與 aggregate precedence 依 [System Design：Report contract](./SYSTEM_DESIGN.md#62-report-contract)。Investigating 只屬後續人工工作階段；checker 不會自行進行未知 runtime 的 unrestricted exploration。Canonical report 僅記 promotion eligibility，CLI summary 在 state transaction 後另附 state_update 結果。

Promotion predicate：

```text
profile == controlled
AND exact version established
AND all applicable required stages passed (no required not_run/blocked)
AND restore + test-owned cleanup verified
AND final environment/session matches initial observation
AND final source fingerprint matches the tested implementation
AND state generation and checker lease still owned
AND report publication succeeded
```

Expected/observed shape failure 在排除 auth、fixture、loading 後才標 incompatible。Timeout／404／empty result 不能一律判為 Desktop breaking change。Blocked report 顯示缺什麼與下一步，不能輸出 compatible。

## 10. Concurrency and recovery

- State transaction lock 使用 exclusive create/lock directory；acquisition 上限 2s，只涵蓋 read-modify-write。
- 每個 endpoint 的 launch/manual check 共用 exclusive execution lease，避免兩個 launches/checks 互相修改；持有至 observation 或 check publication 完成。Read-only check 亦串行化以維持 observation generation 與結果順序。
- Launch 必須先取得 lease 才能 begin observation／kill/restart，不能先檢查 lease 再於未持鎖下操作；遇到有效 lease 以 bounded conflict 結束，不能打斷正在 restore 的測試。一般 commands 不取 lease，fixture ownership drift 由 checker 偵測。
- Lease 保存 owner token、PID、process-start identity（平台可取得時）、heartbeat。不要只因 wall-clock TTL 到期就接管仍活著的 owner；不能證明 owner 已結束則回報 conflict。
- Checker heartbeat 只屬於手動工作鎖，不是 compatibility TTL 或背景版本檢查。每次寫 state 驗證 owner token，避免舊 checker 覆蓋新結果。
- SIGINT/SIGTERM：停止排程、bounded cleanup/restore、保存 interrupted report，最後 release lease。SIGKILL 後可能留下 checking；下一次明確 launch/check 在確認 owner 已結束後設 blocked/interrupted，不能恢復旧 passed。
- 普通 command 只看到 checking 就 warning，不做 PID query／stale-lock recovery。

## 11. Verification and implementation sequence

具體工作、前置依賴與唯一 check ownership 以 [README Tasks](./README.md#tasks) 與各 Task 文件為準。

| Phase | Tasks | Deliverable / verification |
| --- | --- | --- |
| 1 | TASK-001 | version/identity/home store/locks；exact version、atomic state、endpoint isolation、fencing |
| 2 | TASK-002、003 | 全 launch 入口；local-only warning/status，不影響原 handler |
| 3 | TASK-004、005 | 完整 registry declarations、report/read-only CLI、controlled fixture/restore/promotion framework |
| 4 | TASK-006、007、008 | CDP/Target/Context、Chart/Data/History、Study/Strategy；所有 read/controlled assertions |
| 5 | TASK-009～012 | Account、Editor/UI、Graphics/Drawing、Replay 的獨立 provider contracts |
| 6 | TASK-013 | 17 checks 完整 wiring、整合 regression、Live Gate、runbook/support evidence |

TASK-004 提供完整 registry inventory 與 partial implementation 的 not_run 語意；TASK-005 提供唯一 controlled/restore coordinator。Component owners 同時完成 read/controlled handlers、tests 與 wiring；未落地的 required assertion 不能宣稱通過。TASK-013 驗證整合，不延後各任務自身的 tests。

必要負向案例：只跑 status 即宣稱 compatible、read-only 冒充 controlled、未測能力被當成通過、沒有 Strategy fixture、snapshot 中途變化、restore failed、資源不屬於該 Pane、同版較新 failure 被 launch 消除、兩個 writers 遺失其他 endpoint、舊 check 覆蓋新 generation。

本次僅拆分任務與文件依賴，不將任務規劃標成 implementation 或 Live certification 完成。共用交付規則見 [Task delivery contract](./README.md#task-delivery-contract)。
