# TradingView Desktop Version Compatibility Gate

Status: `planned`

## Design documents

- [System Design](./SYSTEM_DESIGN.md)：launcher-first 入口、home 狀態、執行與依賴規則、report schema、結果判定與 flag 更新。
- [LLD](./LLD.md)：module/API、version parser、state/report schemas、CLI contracts、檢測與恢復流程、實作順序。
- [Tasks](#tasks)：TASK-001～013 的實作、依賴與驗收追蹤。

本 README 是檢測範圍、核心元件、功能依賴與逐項通過條件的 source of truth；report schema 與結果判定集中於 System Design。

目前完成設計文件，尚未實作 compatibility commands、launch hooks 或 home state store。

## Objective

建立一套在 TradingView Desktop 升版後可重複執行的相容性驗證流程，確認CLI／MCP shared Core 依賴的必要 Desktop CDP、Runtime、resource identity、data、mutation／restore contracts 仍可運作。

若必要 contract 不再支援，Gate 必須先區分環境問題與 Desktop runtime breaking change，再以 bounded、去識別的方式調查新版替代能力，完成 Core adapter、deterministic regression tests、文件與 Live revalidation 後，才能宣告新版本受支援。

本 Change 依 [Tasks](#tasks) 拆為 13 個可驗收任務，先建立入口／共用框架，再交付 Desktop checks 與整合驗收；後續若特定 Desktop 版本發生 breaking change，應另開 implementation task 或 follow-up Change，不在 Gate 中直接以未審核 workaround 掩蓋失敗。

## Compatibility check scope

檢測對象是 shared Core 實際依賴的 Desktop CDP、Runtime、DOM、資料 shape 與行為。同一個 provider 只驗證一次，再映射受影響的 CLI commands／MCP tools；不建立 MCP 專屬 Desktop 檢測。

分成三類：

| 類別 | 內容 | 是否影響 Desktop compatibility 判定 |
| --- | --- | --- |
| Environment | 正在執行的版本、endpoint、Chart/fixture prerequisites | 是；無法建立前提時 blocked，不推論不相容 |
| Core components | 下節六項圖表／Study／Strategy 底層能力 | 是；第一優先，缺必要 fixture 也不能假通過 |
| Feature dependencies | Account services、Editor/UI、Drawing/Replay/Pine graphics 的獨立 provider | 是；分組報告，不從核心通過推論它們成功 |

CLI/MCP schema/參數傳遞、tool registration、stdio formatting、JSON/CSV serializer、atomic artifact 故障注入、pollLoop dedupe/signal handling、Run/Resume/Extend orchestration、unit/lint/E2E 都屬專案測試。它們不列入 `checks[]`，不要求 user 提供 regression report，也不作 home passed 的前置條件。修正 adapter 或正式發布支援版本時，維護者仍須執行 repo regression，但結果另存 delivery evidence。

Connection/Target 的 live 行為只在 CDP-001/TARGET-001 驗證；不因 MCP 是常駐程序就重複計分。CLI/MCP surface inventory 是開發時 coverage test，不是一個 Desktop probe。

## Entry points and trigger

已確認的入口行為：

- Launch scripts 與 `tv launch` 在 CDP ready 後讀取 live version，重用 `/json/version` response，寫入 `~/.tradingview-mcp/compatibility/state.json`。
- 一般 Desktop-dependent `tv command` 只讀本地 state；passed 時直接執行，未通過／缺失／不可讀時輸出 stderr warning 後仍執行原 command。不查 live version、不自動跑 Gate、不改 command 原本的 exit code。
- 使用者明確執行 `tv compatibility check` 才開始檢測；checker 重新取得 live version，報告預設存 home。通過完整驗收後才更新版本綁定的 passed。
- 第一版不設 TTL，也不做背景版本檢查。`observed_at`／`checked_at` 僅供追溯。
- 接受使用者繞過 launcher 啟動另一版本時，普通 command 可能沿用舊 observation 的 edge case；不因此加入每次 command 的 CDP／process probes。

以下任一條件成立時，應由使用者明確執行 Gate，而非由一般 command 自動觸發：

- TradingView Desktop 的 major、minor 或 patch version 改變。
- Electron／Chromium／CDP version 改變，且 Desktop version 無法可靠取得。
- 既有必要 Runtime API、DOM locator、response shape 或 lifecycle signal 開始失敗。
- 新增一個依賴 TradingView internal runtime 的公開 CLI capability。

每次結果必須綁定 Desktop version、OS／architecture、CDP Browser／Protocol version、Node.js version 與 repo commit；只寫「最新版可用」不算可重現的相容性證據。

觀察版本、完整驗證版本與最新 diagnostic result 分開記錄。Checker／adapter revision 變更亦使既有 passed 失效；schema 與比對規則見 [LLD](./LLD.md)。

## Definition of required information

「必要資訊」是目前受支援 CLI use case 為了定位資源、驗證 ownership、判斷完成狀態或產生正確資料而直接依賴的 observable contract。必要資訊不是要求 internal object 的所有 private fields 永遠相同。

- 驗證應優先檢查公開 CLI／Core response 與必要 capability，而不是硬比對完整 private object。
- Internal path 可以作為 capability provider evidence，但 implementation 應優先使用 capability detection。
- Nullable field 必須明確區分「合法 unavailable」與「必要資料遺失」。例如非帳號擁有的 Layout 可以沒有 `saved_layout_id`，但 Chart Tab 必須能解析 runtime `layout_id`。
- Localized label、使用者命名、CDP target ordering 與固定等待時間不可當成穩定 contract。
- Probe 不可輸出 cookies、tokens、完整 private Pine source、完整 unrestricted runtime object 或非必要帳號資料。

## Required test fixture

完整 Live Gate 應使用可識別且可恢復的測試環境：

- 至少一個帳號擁有的 Saved Layout，可由 runtime `layout_id` 映射到 `saved_layout_id`。
- 至少兩個測試 Chart tabs，其中一個專用 Saved Layout 至少兩個 Chart Panes，具有已知 Symbol、Timeframe 與 Pane identity。
- Pane 內至少一個 Indicator 與一個具有可讀 Report／Trades 的 Account Strategy。
- 一個至少包含兩個完整 `exchange:symbol` identity 的 Watchlist。
- 需要 mutation validation 時使用 disposable Pine Script／Study，並在 readback 後清理；不得修改或刪除使用者既有資產。
- 執行前記錄原 Tab、Layout、Pane、Symbol、Timeframe 與 Study state；任何受控 mutation 都必須 restore 並驗證 readback。

若 fixture 不符合條件，結果應標記為 `fixture_blocked`，不可誤判為 Desktop 不相容。

## Validation workflow

```text
Launch -> observe Desktop version -> reconcile home state
Normal command -> local state only -> optional warning -> original handler

User explicitly runs compatibility check
  -> Re-read live version; record environment and known-good baseline
  -> Run read-only preflight and required capability checks
  -> Run controlled mutation / restore checks
      -> all required checks pass: certify supported version
      -> required check fails:
           -> classify environment / auth / fixture / runtime failure
           -> capture bounded sanitized evidence
           -> investigate replacement capability in the new version
           -> update shared Core adapter + old/new regression fixtures
           -> rerun the complete Gate
```

局部 command 再次成功不足以解除 failure；完成修正後必須重新執行完整 Gate，避免新版替代方式破壞其他 vertical slices。

## Required validation matrix

下表為 grouping；詳細 assertions、providers、fixture、read-only／controlled 通過條件見本文件的 [Core component checks](#core-component-checks) 與 [Feature dependency checks](#feature-dependency-checks)。不是只驗證 method presence。

| Group | Checks | 必要 contract |
| --- | --- | --- |
| Environment | ENV-001 | live version/source、environment tuple、fixture prerequisites |
| Core 1：CDP transport／Runtime | CDP-001 | WebSocket、evaluate／awaitPromise／callFunctionOn round-trip、自有 client reconnect |
| Core 2：Target／Layout／Pane | TARGET-001、CONTEXT-001 | 正確 target、Layout catalog mapping、Pane ownership、切換後定位與恢復 |
| Core 3：Chart runtime | CHART-001 | Symbol/resolution/type/range、ready、mutation readback/restore |
| Core 4：Main Series／Data | DATA-001、HISTORY-001 | bar shape、time/numeric invariants、older-data progress/stop、完整性 |
| Core 5：Study／Inputs | STUDY-001 | Entity/source mapping、metadata/type/Inputs、test-owned mutation/restore |
| Core 6：Strategy | STRATEGY-001 | active source、calculation lifecycle、fresh Report、Trades/equity、snapshot consistency |
| Account services | PINE-ACCOUNT-001、WATCHLIST-001、ALERT-001 | 已登入下 list/read 帳號資源；獨立 controlled fixture 的 write/readback/cleanup |
| Editor／UI | PINE-001、UI-001 | DOM/React/Monaco、必要 panels/dialogs/canvas、compile/error readback、CDP screenshot |
| Feature runtime | GRAPHICS-001、DRAWING-001、REPLAY-001 | Pine primitives、shape lifecycle、opt-in Replay lifecycle/restore |

CLI/MCP wrapper、surface inventory completeness、Run/Resume/Extend orchestration、Stream pollLoop、output serializer/artifact publish 與 repo regression 留在專案測試，不列為 Desktop checks、不影響 home passed。共用底層能力只測一次，report 映射兩個入口的受影響 surfaces。

## Core component checks

維持既有 matrix ID；六個 component 對應八個 checks，以便區分定位、歷史資料等不同失敗來源。每個 stage 有穩定 assertion ID，例如 `CDP-001.read.evaluate_sync`；每個 assertion 紀錄 capability/data/behavior 類型，不只檢查方法存在。

### CDP transport and Runtime bridge — CDP-001

Provider：[connection.js](../../src/connection.js)。

- **Read-only**：`/json/list` shape、Chart WebSocket 可連線；Runtime evaluate 讀取固定 primitive/object；awaitPromise 能回傳預期值；callFunctionOn 的 JSON argument 往返正確且 remote object 可釋放。
- **Controlled**：在 checker 自有 CDP client 執行 disconnect→reconnect，確認同一個預期 target 能重新 evaluate；不 kill Desktop、不打斷其他連線。
- **Pass**：實際 round-trip 結果正確，所有動作在 timeout 內完成。
- **Blocked**：CDP 未啟動、endpoint 不可達、Desktop 仍在載入；記錄 environment failure。
- **Fail**：在已建立的正確 endpoint 上，必要 protocol operation 可重現地缺失或回傳不符合契約。
- **Evidence**：protocol、operation names、return types、round-trip match、duration；不保存原始 page global/object dump。
- Promise rejection、人工 timeout／網路故障注入的 error formatting 放在 repo tests；Live 真正發生的 timeout 仍必須 bounded 並記錄。

### Target, Layout and Pane identity — TARGET-001 / CONTEXT-001

Providers：[tab.js](../../src/core/tab.js)、[layout-identity.js](../../src/core/layout-identity.js)、[pane.js](../../src/core/pane.js)。

- **Read-only**：分辨 shell/chart targets；依現行 focus/visibility contract 解析 active target；collection.getAll 與 active widget 對應正確；runtime Layout、Saved Layout catalog、Pane identity 可互相驗證。
- **Controlled**：在兩個已指定的測試 Chart tabs 間切換並回復；在多 Pane fixture 中切換／操作指定 Pane，確認其他 Pane 未被誤用，最後恢復原 active Tab/Pane。
- **Pass**：target、runtime layout、saved layout 與 pane identities 一致且唯一；不能用 target list 第一筆或名稱猜測補值。
- **Nullable**：非帳號 Saved Layout 的 saved_layout_id 可為 null；用來驗證 catalog mapping 的 account-owned fixture 則必須能解析。
- **Fixture**：完整 controlled 驗證需要兩個 Chart tabs，其中一個專用 Saved Layout 至少兩個 Panes；缺少時對應 assertion blocked。
- **Evidence**：target count、resolution method、mapping matched、ownership matched、restore matched；實際 IDs 採 run-local aliases，供報告內對照。
- 3.3.0／3.4.0 provider 差異使用 local sanitized fixtures 回歸；Live 僅探測目前版本必要 provider，不要求舊 internal path 在新版仍存在。

### Chart runtime and mutation readiness — CHART-001

Providers：[chart.js](../../src/core/chart.js)、[chart-session.js](../../src/core/chart-session.js)、[wait.js](../../src/wait.js)。

- **Read-only**：active chart wrapper→chartWidget→model 可取得；symbol、symbolExt 的完整身分、resolution、chartType、visible range 具有可用 shape。
- **Controlled**：同一 pinned Pane 上依序切換已知 symbols/timeframes、測試 chart type／visible range，再恢復；驗證每次 readback 與 loading/ready 行為。
- **Pass**：API symbol 與 resolved symbol 相符、resolution 正確、資料屬於新 context；不能只因 setter 沒 throw 或畫面標題改了就通過。
- **Evidence**：requested/resolved identity_match、resolution_match、ready duration、restore fields 的 matches；不要求行情價格固定不變。

### Main Series and data structures — DATA-001 / HISTORY-001

Provider：[data.js](../../src/core/data.js)；同時涵蓋 quote/stream/replay 讀取 bars 的共享資料來源。

- **Read-only**：bars().firstIndex/lastIndex/valueAt/size；bar tuple 的 time/open/high/low/close/volume；quote、symbol metadata 及已知 indicator 的必要 numeric values。
- **Controlled**：requestMoreData 向前載入一個 bounded batch，觀察 earliest timestamp／bar count／requestMoreDataAvailable 的進度或合法終止；恢復圖表選擇與可見範圍。
- **Pass**：時間為 Unix seconds、ISO companion 對應、資料不重複且按時間遞增；必要 OHLC 數值 finite、價格關係合理；history 的 no-progress/max-limit 不偽裝成完整資料。
- **Nullable**：無 volume 的商品、Study warm-up/null 值依 fixture 宣告處理，不要求所有欄位一律非 null；至少一組已知 valid fixture 驗證 numeric contract。
- **Evidence**：tuple length/type summary、sample size、invalid count、ordering/dedupe check、oldest timestamp before/after、progress、stop reason、complete。
- HISTORY fixture 若已無更多 bars，可驗證 stop assertion；若未驗證 required progress assertion，仍 blocked，不能因 no_more_data 而將整項 pass。
- 載入 bars 不可逆地增加 runtime cache；restore 驗證選擇、範圍與資料身分，不要求 bar_count 恢復成原數字。這屬明確 controlled effect。

### Study metadata, Entity and Inputs — STUDY-001

Provider：[studies.js](../../src/core/studies.js)。

- **Read-only**：getAllStudies/getStudyById 對應 model().model().dataSources；Indicator/Strategy 與 built-in/account 分類；entity_id、script_id/version、visibility、Input IDs/names/types/constraints/values。
- **Controlled**：專用 fixture 上新增／移除 test-owned Study，修改一項合法 Input、toggle visibility，讀回並恢復。
- **Pass**：public Entity 與 internal source 是同一個 Pane 資源；metadata 足以正確分類 fixture；Input readback 與指定 ID/name/value 相符，未誤改其他 Study。
- **Evidence**：expected/observed type、entity/source mapping、Input definition fingerprint、mutation/restore matches、created/removed entity alias。
- 找不到 Study／缺有效 inputs 的測試資料為 fixture blocked；已有 fixture 卻因 provider shape 改變無法解析才判 contract failure。

### Strategy lifecycle and reports — STRATEGY-001

Providers：[strategy-runtime.js](../../src/core/strategy-runtime.js)、[strategy-trading.js](../../src/core/strategy-trading.js)、[strategy.js](../../src/core/strategy.js)。

- **Read-only**：activeStrategySource、status、reportData/ordersData；performance metrics、paired closed/open trades、equity、snapshot 必要欄位；不得暗中 select 另一個 Strategy。
- **Controlled**：使用 CHART-001/STUDY-001 的 mutation context 驗證本輪重新計算、fresh Report、兩批以上的讀取與前後 snapshot 一致性，之後 restore。
- **Pass**：目前 adapter 依賴的 status 1/2 語意成立，或有已驗證 replacement provider；完成狀態與 fresh evidence 同時成立；trade counts/order／paired records 正確、資料屬於指定 Strategy/Symbol/Inputs。
- **Evidence**：status sequence、freshness evidence kind、stable read count、report_available、closed/open counts、trade ordering、snapshot before/after comparison、missing required fields。
- Fixture 必須有足以驗證分頁的 trades，並明確配置可驗證 open-trade/empty-trade 分支的案例；未涵蓋的 required 分支不能由方法存在推論通過。
- 成交價格／profit 的精確數字可隨行情變動，不直接與上個 Desktop 版本硬比；比較 identity、schema、內部一致性及必要的計算語意。

## Feature dependency checks

這些項目與六個核心分組分開展示，但都屬現有功能的真實外部依賴。預設完整 registry 包含以下項目，沒有自動「核心成功即全功能成功」的推論。

| Check | Read-only assertion | Controlled assertion | Main provider |
| --- | --- | --- | --- |
| PINE-ACCOUNT-001 | 已登入頁面能 list Saved Pine；非空 entries 的 script_id/version 可解析；known fixture 可讀取指定版本 | pineLibApi saveNew/saveNext 的 disposable Script readback/delete cleanup | pine.js；pine-facade / pineLibApi |
| WATCHLIST-001 | Account lists 的 ID/schema；known named list detail 有完整 ordered exchange:symbol，count/fingerprint 穩定 | 驗證 existing add/remove adapters，但只操作使用者指定可修改的測試 Watchlist，記錄原內容後還原 | watchlist.js；symbols_list API／現行 add UI |
| ALERT-001 | 已登入頁面能 list；alert_id、symbol、conditions/state 可解析 | disposable Alert create/list/delete，readback cleanup；測試條件避開觸發，若無法抑制通知則此 mutation blocked | alerts.js；pricealerts REST |
| PINE-001 | Editor 已開啟時可解析 DOM→React fiber→Monaco 與必要 model methods；未開啟為 fixture blocked | 在專用 Editor fixture 開啟/讀寫/compile，驗證成功與已知語法錯誤 diagnostics，恢復 editor/UI | pine.js；Monaco/React/bottomWidgetBar |
| UI-001 | 已存在 shell/panel/canvas locator 可唯一解析；CDP screenshot 有效，指定 region bounds 非空 | 驗證必要 panel/dialog 的開關與 Input 驅動，Tab create/close 僅限 test-owned tabs，恢復 UI；depth DOM 僅在已證實 entitlement 適用時驗證 | ui.js、indicators.js、tab.js、capture.js、data.js |
| GRAPHICS-001 | 可見測試 Study 的 lines/labels/tables/boxes primitives 可讀，座標／文字／cell shape 與 fixture 相符 | 如需建立 graphics fixture，交由 STUDY-001 的 test-owned setup/cleanup；不重複創建 | data.js、stream.js 的 _graphics readers |
| DRAWING-001 | shape inventory、entity lookup、points/properties 解析 | test-owned create/get/remove，確認 geometry、Entity ID 與 cleanup | drawing.js；Chart shape API |
| REPLAY-001 | _replayApi 必要 methods、manager/UI state 與目前 chart data 可讀 | 獨立 opt-in fixture 的 selectDate→step→goToRealtime→stopReplay，驗證資料與 restore；Replay Trading 另行 opt-in | replay.js |

Account 基本檢測的意思是「已登入下是否能列出帳號的 Pine scripts、Watchlists、Alerts」，不讀出 cookie/token、不重新登入。合法空清單可讓 inventory assertion pass；需要指定資源的 detail／mutation assertion 仍需 fixture，不能以空清單取代。失敗來源可能是 auth/network 或遠端 service contract，報告不得直接寫成 Desktop 升版造成。

Pine Editor/graphics fixture 的 setup 不得混入 read-only；controlled 先準備 fixture，再執行相同 pure probes。Alert、Watchlist、Pine mutation 與六項核心的測試資產清理 ledger 共用，禁止 delete-all／修改任意使用者資產。

Replay 不使用 selectFirstAvailableDate；從已載入有效 bars 的最近區段取 bounded 10% point，等待 selectDate Promise，先 goToRealtime 後 close session，驗證版本實際順序。Default 未 opt-in 時 controlled assertions 顯示 not_run；只看 method existence 不能通過行為檢查。

## Result states

Desktop report 區分 compatible、diagnostics_passed、incompatible、環境／fixture／coverage blocked、restore failure、中斷與 checker error。Read-only 通過不建立新的完整 passed；尚未驗證不能視為不相容，也不能視為通過。

Assertion status、overall_status precedence、compatible 三值語意、home flag promotion 以 [System Design：State versus report result](./SYSTEM_DESIGN.md#6-state-versus-report-result) 為準。Investigation 是後續人工工作階段，不是本輪檢測的成功狀態。

## Unsupported-contract investigation policy

當 required check 失敗時，依序執行：

1. 使用相同 repo commit 重跑一次，排除 transient calculation、stale target 或未完成載入。
2. 確認 environment、登入、entitlement 與 fixture prerequisites，分類是否真的為 version incompatibility。
3. 記錄失敗的 observable contract、最後已知可用 Desktop version、第一個失敗版本、error code／stage 與 bounded sanitized evidence。
4. 在新版只 probe 與失敗 contract 有關的 object paths、method availability、return types、必要 keys 與 lifecycle；禁止 unrestricted recursive dump。
5. 找出替代 provider 後至少驗證正常、缺失／錯誤與重複執行三種情境。
6. 優先在 shared Core adapter 加 capability detection 與 backward-compatible fallback；只有無可靠 capability discriminator 時才使用明確 Desktop version branch。
7. 新增舊版與新版 sanitized fixtures／tests，並更新 Terminology、runtime contract、support matrix 與 Change completion evidence。
8. 重新執行全部 required checks；不能只驗證原本失敗的單一 command。

若沒有可信替代能力，應保留 structured unsupported error 並將該 Desktop version 標記為 `incompatible`；不可用 UI timing、localized text、猜測第一個 Tab／Pane／Strategy 或舊資料 fallback 偽裝成功。

## Target report contract

預計提供 CLI-first 的 machine-readable Gate：

```bash
tv compatibility status
npm run tv -- compatibility check
npm run tv -- compatibility check --profile read-only --output compatibility.json
npm run tv -- compatibility check --profile read-only --desktop-version 3.4.0 --output compatibility.json
npm run tv -- compatibility check --profile controlled --fixture /absolute/path/fixture.json --output compatibility-controlled.json
```

Report 欄位、逐項 evidence、coverage/impact、restore/cleanup、promotion 與結果範例集中於 [System Design：Report contract](./SYSTEM_DESIGN.md#62-report-contract)。

`read-only` 是 default，用於升版後第一輪安全診斷；不得開啟面板、啟用不同 Strategy 或切換圖表後再宣稱 read-only。更新完整 passed 需要在專用 fixture 上完成 controlled 的全部適用契約與 restore/cleanup；不要求 user 先執行 repo tests。詳見 [LLD manual CLI contract](./LLD.md#7-manual-cli-contract)。

每次 report 預設寫入 `~/.tradingview-mcp/compatibility/reports/`，`--output` 是額外副本，不得覆寫既有檔案，除非明確指定 `--force`。檢測程式保留於 repo／套件，home 不存另一套可執行 checker。

## Scope decisions and validation

- 移除 Desktop report 的 SURFACE-001、AUTOMATION-001、RESUME-001、STREAM-001、OUTPUT-001、REGRESSION-001。這些 ID 尚未實作；對應工作保留於 repo coverage/regression/integration tests，不做 report check 或 passed prerequisite。
- Runtime rebind／資料供應源分別歸 TARGET/CONTEXT/STUDY/STRATEGY/DATA/GRAPHICS；Pine account 與 Editor 分開，新增 PINE-ACCOUNT-001、GRAPHICS-001。不重複跑相同 shared provider。
- 移除 `--regression-report` 與專用 regression runner 規劃；使用既有 package scripts 驗證實作品質。
- 最小 read-only 可以在現有 fixture 做診斷；完整 passed 仍需 controlled 行為及適用 feature dependencies。沒有新增自動檢測、TTL 或 MCP 特有認證。
- Registry/surface completeness、report schema/counts、aggregation truth table、redaction、state promotion failure 等用 deterministic tests 驗證。它們是 checker 的測試，不是 user report 裡的 Desktop 能力。
- Acceptance：known-good fixture 回報通過；missing fixture 不誤判 incompatible；method/shape/identity/freshness 失敗可定位 root cause；未執行的 assertions 與 dependency impact 明確可見；restore/publish failure 不錯寫 passed。

## Tasks

原單一 Gate task 已拆為下列 13 項；TASK-001 改為 foundation，不再代表整個 Change。所有任務目前為 todo。

| ID | Task | Check ownership | Status | Depends on |
| --- | --- | --- | --- | --- |
| [TASK-001](./TASK-001-version-identity-home-state.md) | Version identity and home state foundation | — | `todo` | — |
| [TASK-002](./TASK-002-launch-version-observation.md) | Shared launch version observation | — | `todo` | TASK-001 |
| [TASK-003](./TASK-003-cli-local-advisory-status.md) | Local-only CLI advisory and compatibility status | — | `todo` | TASK-001 |
| [TASK-004](./TASK-004-checker-registry-report-cli.md) | Checker registry, report pipeline and read-only CLI | ENV-001 | `todo` | TASK-001、TASK-003 |
| [TASK-005](./TASK-005-controlled-fixture-restore-promotion.md) | Controlled fixture, restore and state promotion coordinator | — | `todo` | TASK-001、TASK-004 |
| [TASK-006](./TASK-006-cdp-target-context-checks.md) | CDP, Target, Layout and Pane checks | CDP-001、TARGET-001、CONTEXT-001 | `todo` | TASK-004、TASK-005 |
| [TASK-007](./TASK-007-chart-data-history-checks.md) | Chart, Main Series and history checks | CHART-001、DATA-001、HISTORY-001 | `todo` | TASK-005、TASK-006 |
| [TASK-008](./TASK-008-study-strategy-checks.md) | Study Inputs and Strategy lifecycle checks | STUDY-001、STRATEGY-001 | `todo` | TASK-005、TASK-006、TASK-007 |
| [TASK-009](./TASK-009-account-service-checks.md) | Account Pine, Watchlist and Alert checks | PINE-ACCOUNT-001、WATCHLIST-001、ALERT-001 | `todo` | TASK-005、TASK-006 |
| [TASK-010](./TASK-010-editor-ui-checks.md) | Pine Editor and UI provider checks | PINE-001、UI-001 | `todo` | TASK-005、TASK-006 |
| [TASK-011](./TASK-011-graphics-drawing-checks.md) | Pine graphics and Drawing checks | GRAPHICS-001、DRAWING-001 | `todo` | TASK-005、TASK-006、TASK-008 |
| [TASK-012](./TASK-012-replay-checks.md) | Opt-in Replay lifecycle checks | REPLAY-001 | `todo` | TASK-005、TASK-006、TASK-007 |
| [TASK-013](./TASK-013-integration-live-validation-delivery.md) | Integration, Live validation and delivery evidence | — | `todo` | TASK-002、TASK-003、TASK-006、TASK-007、TASK-008、TASK-009、TASK-010、TASK-011、TASK-012 |

### Recommended implementation order

1. TASK-001：版本／identity／home state／共用鎖。
2. TASK-002、003：launch observer 與 local-only advisory/status；兩者不互相依賴。
3. TASK-004 → TASK-005：registry/report/read-only CLI，再接 controlled fixture/restore/promotion。
4. TASK-006 → TASK-007 → TASK-008：連線定位 → Chart/Data → Study/Strategy 六核心。
5. TASK-009、010 在 TASK-006 後可交付；TASK-011 在 TASK-008 後、TASK-012 在 TASK-007 後交付。
6. TASK-013：等所有入口與 check owners 完成後做完整整合、Live Gate 與交付證據。

### Task delivery contract

- 所有任務沿用已確認流程：launch 查版本、普通 command local-only warning、手動檢測更新 home；沒有 TTL、背景檢測或 MCP 專屬 Desktop Gate。
- 每項實作連同有意義的 tests、必要 fixture、registry/CLI wiring 與文件交付；不把 component tests 全部延至 TASK-013。
- Desktop checks 由上表唯一 owner 負責全部適用 read/controlled assertions；fixture/restore/report infrastructure 由 TASK-004/005 提供，各 owner 不複製另一套框架。
- TASK-004 起 registry 即宣告完整 17 IDs。未交付的 required handler 明確 not_run 且不能產生完整 passed；coverage tests 分辨已宣告與已實作，TASK-013 要求全部落地。不可刪除 registry 項目或加永久 skip 讓測試假通過。
- State/report publication correctness、wrapper/schema、surface inventory、repo regression 是實作品質測試，不列入 user Desktop report，也不是 user 執行 check 的前置條件。
- Genuine version breaking change 另開 follow-up adapter task；本輪保留 expected/observed、已排除原因、版本 tuple、known-good 或 unknown baseline、bounded reproduction evidence，不自動猜 workaround。
- Component Live evidence 與全環境 certification 分開：局部完成不表示完整 compatible。缺環境/fixture/entitlement 時如實記錄，TASK-013 不得以未測取代通過。
- 完成任務時更新該 Task status、commands/results、變更檔案、Live環境與限制（適用時）以及 README index；純文件拆分保持 todo。

## Exit criteria

- 所有受控 launch 入口使用共用版本解析與狀態轉換，同版不消除失敗紀錄，異版不沿用舊 passed。
- 一般 CLI advisory 經測試證明 local-only、warning-only、無 TTL，不影響原 handler／stdout／exit code。
- Home state/report schema、atomic publication、endpoint isolation 與 concurrent writer safeguards 已完成。
- Required validation matrix 已轉換成 versioned、machine-readable assertions。
- 所有依賴 Desktop runtime 的公開 CLI surfaces 都映射至 required 或有明確前置條件的 checks。
- Gate 能區分 incompatible、blocked、not_run、not_applicable 與 checker error，並分開回報 root failure／dependency impact。
- Read-only profile 不改變 Desktop state；controlled profile 對所有 mutation 完成 restore readback。
- 任一 required check 失敗時不會輸出 `compatible`，並產生足以開始 bounded investigation 的安全 evidence。
- 新版 adapter 必須同時具有舊版與新版 regression coverage，且完整 Gate 重跑通過後才能加入 support matrix。
- 文件列出最後已驗證的 Desktop、Electron／Chromium／CDP 與 repo version tuple，不使用浮動的「latest」。

## Completion record

2026-10-13：檢測清單整合於本 README；assertion result、report schema 與 flag 更新規則整合於 System Design，LLD 與任務引用同步更新。Wrapper、Automation／Resume／Stream orchestration、output 與 regression 屬專案測試。Launch/home/manual-check 流程不變；尚未執行真實 mutation、寫入 home flag 或認證 Desktop 3.4.1；TASK-001～013 均維持 todo。

Task decomposition：原單一 Gate 任務拆為 foundation、launch/advisory、checker/restore、七組 check owners 與整合驗收；不改既定檢測範圍與 report contract。
