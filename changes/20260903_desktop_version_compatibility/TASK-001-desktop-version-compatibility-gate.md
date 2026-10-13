---
id: TASK-001
title: TradingView Desktop version compatibility gate
status: todo
phase: desktop-version-compatibility
depends_on: []
blocks: []
scope: local-and-live
---

# TASK-001: TradingView Desktop version compatibility gate

## Goal

實作 CLI-first、可重複執行的 TradingView Desktop 升版相容性 Gate，驗證 [`Required validation matrix`](./README.md#required-validation-matrix) 中的必要資訊與行為；必要 contract 缺失時，安全地分類問題並提供新版 runtime investigation、adapter 修正與完整 revalidation 流程。

入口依 2026-10-13 已確認的 [System Design](./SYSTEM_DESIGN.md) 與 [LLD](./LLD.md)：launch 查版本並更新 home state；一般 command 只讀本地 flag，未通過時 warning 後繼續執行；使用者手動執行完整檢測才可更新 passed。不設 TTL、不在一般 command 查 live version 或自動跑檢測。

## Requirements

### In scope

- 整合 macOS／Linux／Windows BAT／VBS 與 shared Core `launch()`，在 CDP ready 後使用共同版本 parser／state transition；重用既有 response。
- 實作 `~/.tradingview-mcp/compatibility/` 的 version-bound state、canonical reports、endpoint isolation、atomic publication 與 writer/runner locks。
- CLI leaf metadata 與 local-only advisory：help／local／launch／compatibility 豁免；其他 Desktop commands 未通過時 stderr warning-only，不影響 handler、stdout schema 或 exit code。
- 區分 observed version、verified version、read-only diagnostics 與完整 passed；checker／adapter revision 變更使舊 evidence 失效，不採 TTL。
- 建立 versioned compatibility check registry，每個 check 具有 stable ID、required flag、profile、timeout、result status 與 bounded evidence contract。
- 收集 Desktop／CDP／OS／Node／repo environment tuple；Desktop exact version 無法自動判斷時要求明確 CLI input 並記錄 source，不猜測版本。
- 建立公開 Desktop-dependent CLI／Core surface inventory，要求每個 surface 映射至 required 或具有明確 entitlement／fixture precondition 的 check。
- 實作 local-only `compatibility status` 與手動 `compatibility check` 的 `read-only` default／`controlled` profiles；home report 預設保存，支援 atomic JSON 額外 `--output`／`--force`。
- 依 [README 檢測清單](./README.md#required-validation-matrix) 驗證六個核心元件與 Account／Editor/UI／Drawing/Replay/Graphics providers；共同 Core 只測一次，不新增 MCP 專屬 Desktop checks。
- 建立 controlled fixture、assertion-level result、failure_origin、version_relation、coverage／impact／restore／promotion report；read-only 或缺必要 Desktop 檢查時不可 promote passed。不要求 user 提供 regression evidence。
- Replay controlled profile必須驗證`selectDate()` Promise、有效bars比例選點、manager／UI state語意、`goToRealtime()`後再close session的版本順序，以及symbol／resolution／bars restore；不得使用最早可用日期或在Strategy E2E中執行Replay。
- Controlled profile 在 mutation 前建立 immutable restore context，成功或失敗都嘗試恢復，並對 restore 結果 readback。
- 將 environment、fixture、optional capability 與 confirmed Desktop incompatibility 分開分類。
- Required check 失敗時輸出失敗 contract、provider path、expected／observed shape、最後已知相容版本與 sanitized diagnostic；不輸出 unrestricted runtime data。
- 為已知 Desktop 3.3.0／3.4.0 Layout identity 差異建立 regression case：legacy `_prevChartState.id` 不可作為唯一來源；3.4.0 runtime `layout_id` 由 `_saveChartService.layoutId()` 取得，account `saved_layout_id` 由 Saved Layout catalog mapping 取得。
- 建立 support matrix 與每次認證的 completion evidence template。

### Out of scope

- 把 MCP/CLI wrapper、tool schema/stdio、surface inventory tests、Run/Resume/Extend orchestration、pollLoop、output serializer/artifact fault tests、unit/lint/E2E 列為 Desktop checks；這些保留於 repo 測試與交付驗收。

- TTL、背景輪詢、一般 command 的 live version／process inspection、自動執行 compatibility checks 或因 advisory 阻止 handler。
- 防止使用者繞過受控 launcher 啟動另一版本後沿用本地 observation；此 edge case 已接受。
- 自動升級或降級 TradingView Desktop。
- 在 CI 啟動已登入的真實 Desktop session。
- 對 unknown runtime object 執行 unrestricted recursive dump。
- 將 Community Scripts、Broker execution、entitlement-only capability 或尚未公開支援的 feature 升格為 required checks。
- Gate 內直接加入未經 review 的 version-specific workaround。
- 為了完成測試修改或刪除使用者既有 Saved Layout、Watchlist、Pine Scripts 或 Studies。

### Constraints and references

- [`Compatibility Gate design`](./README.md)
- [`System Design`](./SYSTEM_DESIGN.md)
- [`LLD`](./LLD.md)
- [`Report contract`](./SYSTEM_DESIGN.md#62-report-contract)
- [`TradingView MCP Terminology Definition`](../../docs/terminology.md)
- [`Study and Strategy CLI LLD`](../20260821_study_strategy_cli/LLD.md)
- [`Strategy Trading runtime contract`](../20260831_strategy_trading/RUNTIME_CONTRACT.md)
- Existing CDP lifecycle: [`src/connection.js`](../../src/connection.js)
- Existing safe Core errors: [`src/core/errors.js`](../../src/core/errors.js)
- Existing Desktop launch scripts: [`scripts/`](../../scripts)

## Design

### Module boundaries

```text
Launch scripts / shared Core launch
  -> live version observation -> home state
CLI router
  -> local-only advisory -> original command handler
CLI: compatibility check
  -> Compatibility application service
       -> versioned check registry
       -> existing Core read/mutation adapters
       -> restore coordinator
       -> result classifier
       -> sanitized evidence builder
       -> existing atomic artifact transaction
       -> conditional home state promotion
```

CLI 只負責 parse／validate arguments、呼叫 application service 與輸出 bounded summary。Check 不得啟動低階 CLI subprocess；應直接重用既有 Core modules，使未來 shell 與 MCP 都能使用同一 contract。

### Execution stages

1. **Preflight**：取得 checker lease、重新讀取 live version、固定 observation generation／environment，驗證 CDP、登入狀態、fixture prerequisites 與 bounded timeout。
2. **Read-only checks**：執行所有不改變 Desktop state 的 required checks。
3. **Restore snapshot**：Controlled profile 固定 target／layout／pane／symbol／timeframe／study identities。
4. **Controlled checks**：只使用已核准 fixture 執行 mutation＋readback。
5. **Restore**：在 `finally` 恢復並驗證；restore failure 使整體結果失敗。
6. **Coverage**：確認所有適用 Desktop assertions 的狀態、依賴與 exclusions；未執行不能視為 pass。Repo regression 另屬維護者交付驗收。
7. **Classification**：依 required failures 與 preconditions 產生 overall status。
8. **Publish**：確認最終 environment／generation 未變，完整 report 先 atomic publish，再有條件更新 home state；CLI 依既有 success/error routing 輸出 bounded summary。

### Failure semantics

- Required contract missing／shape changed：`DESKTOP_VERSION_INCOMPATIBLE`。
- CDP／process／login／permission unavailable：`COMPATIBILITY_ENVIRONMENT_BLOCKED`。
- 測試 Layout／Strategy／Watchlist／history data 不足：`COMPATIBILITY_FIXTURE_BLOCKED`。
- Controlled state 無法恢復：`COMPATIBILITY_RESTORE_FAILED`。
- Check timeout：保留 check ID、stage、`timeout_ms`，且不得讓後續 process 永久 pending。
- 已證實 entitlement 不適用：assertion 記 not_applicable 並保留 evidence；未提供 fixture／opt-in 不能當作不適用。
- Confirmed runtime/service contract failure 與 version-related cause 分開；單次失敗不宣稱 Desktop 升版造成。

### Investigation handoff

Confirmed incompatibility report 必須足以建立 follow-up implementation task，至少包含：

- Desktop environment tuple 與 affected check ID。
- Expected observable contract、actual safe observation與最小重現 command。
- 已排除的 environment／fixture causes。
- 已知 provider path 與 bounded capability inventory。
- 最後已知相容版本與第一個失敗版本。
- 建議調查範圍；不得直接假定 replacement API。

找到 replacement 後，follow-up task 必須修改 shared Core adapter、加入 old/new fixtures、驗證 structured failure，並重跑完整 Gate。

## Verification and Delivery

### Tests

- Launch 同版／異版／未知版、token conflict、全部啟動入口共用 parser、CDP timeout、pending launch crash、home write failure。
- Router advisory 零 network/CDP/process/write、一次 invocation 一次 stderr warning、原 command 成功／失敗 exit code 保持不變、help/local 豁免。
- Missing/corrupt/oversized home state、endpoint isolation、revision invalidation、atomic concurrent updates、read-only 不建立完整 passed、舊 checker 不覆蓋新 observation。
- Registry completeness：每個 required matrix ID 都有 implementation，ID 不重複且 timeout 有上限。
- Public surface coverage：每個 Desktop-dependent CLI command／Core adapter 都映射至 check，新增 command 未登錄時 test 失敗。
- Result classification：assertion 五種狀態、overall precedence、compatible 三值、environment/fixture/dependency/checker 分類，以及 counts 加總一致。
- Report root failures／affected CLI+MCP surfaces／missing assertions／restore／promotion 語意；檔案發布先於 flag，state_update 另於 summary 回報。
- Environment collection與 unavailable metadata。
- Desktop 3.3.0 legacy／3.4.0 runtime Layout identity fixtures。
- Read-only profile 無 mutation；controlled profile success／mid-operation failure／restore failure。
- Sanitization：不洩漏 cookies、tokens、完整 Pine source、帳號 private payload 或 unrestricted objects。
- Atomic output、existing target／`--force`、write failure cleanup與 bounded stdout。
- CLI help、argument validation、exit codes與 no-hanging-process。
- Live smoke：多 Tab、Saved Layout mapping、Pane ownership、Strategy Report／Trades、History、Watchlist、disposable Pine／Study cleanup。

### Acceptance criteria

- [ ] 所有受控 launch 入口能登錄版本，同版保留有效狀態，異版 unchecked，失敗不沿用舊 passed。
- [ ] 普通 command 只讀本地 flag，未通過 warning 後仍執行，不查 live version、不設 TTL。
- [ ] Home state／reports 可跨 cwd 使用，schema／atomic write／endpoint isolation／concurrency 行為符合 LLD。
- [ ] `compatibility status` 完全 local-only；`compatibility check --profile read-only` 可產生診斷報告，controlled stages 明確 not_run，不 promote passed。
- [ ] `compatibility check --profile controlled` 只操作核准 fixture，且 success／failure 都 restore 原 state。
- [ ] 每個 required check 都具有 stable ID、timeout、expected contract與deterministic coverage。
- [ ] 所有 Desktop-dependent CLI／Core surfaces 都有 Gate coverage 或明確 entitlement／fixture precondition。
- [ ] 任一 required contract 失敗時 overall status 不會是 `compatible`。
- [ ] 環境、登入、entitlement、fixture 與 Desktop breaking change 可被明確區分。
- [ ] Desktop 3.3.0／3.4.0 Layout ID contract 都有 regression coverage。
- [ ] Investigation evidence bounded、去識別，且足以開 follow-up adapter task。
- [ ] 新版支援必須在完整 Gate 重跑成功後才更新 support matrix。
- [ ] Lint、unit、CLI、full deterministic regression與 `git diff --check` 通過。

### Validation commands

Target commands：

```bash
fnm exec --using=22 npm run tv -- compatibility status
fnm exec --using=22 npm run tv -- compatibility check --profile read-only --output compatibility.json
fnm exec --using=22 npm run tv -- compatibility check --profile read-only --desktop-version 3.4.0 --output compatibility.json
fnm exec --using=22 npm run tv -- compatibility check --profile controlled --fixture /absolute/path/fixture.json --output compatibility-controlled.json
```

以上新介面尚待實作；適用 Replay 時依 LLD 另加 opt-in flags。下列 repository gate 屬 checker/adapter 實作品質驗收，不是 user 執行 compatibility check 的先決條件。

Repository gate：

```bash
fnm exec --using=22 npm run lint
fnm exec --using=22 npm run test:unit
fnm exec --using=22 npm run test:cli
fnm exec --using=22 npm run test:all
git diff --check
```

在 target command 尚未實作前，Live baseline 至少包含：

下列是既有 command 的人工 baseline，並非嚴格 read-only profile；例如 `watchlist get` 可能開啟面板。不可直接把整份清單當成無副作用的 probe 實作。

```bash
fnm exec --using=22 npm run tv -- status
fnm exec --using=22 npm run tv -- tab list
fnm exec --using=22 npm run tv -- layout list
fnm exec --using=22 npm run tv -- state
fnm exec --using=22 npm run tv -- study list
fnm exec --using=22 npm run tv -- strategy active
fnm exec --using=22 npm run tv -- watchlist list
fnm exec --using=22 npm run tv -- watchlist get
```

### Deliverables

- System Design／LLD 所定義的 shared launch observer、home state store、local-only router advisory 與 compatibility status。
- Compatibility check registry與Core application service。
- CLI command、versioned JSON report schema與atomic output；含 assertion-level findings、coverage、CLI/MCP impact、restore/cleanup、promotion eligibility。
- Environment／fixture／runtime classifiers與safe diagnostics。
- Desktop Layout legacy／current fixtures及完整 deterministic tests。
- Live runbook、support matrix、completion evidence與相關 terminology／runtime documentation updates。

## Completion record

2026-10-13：檢測清單整合於 README，report schema／判定整合於 System Design，LLD 與本任務引用已同步；範圍維持 Desktop shared-Core contracts，wrapper/一般 regression 屬專案測試。Runtime implementation、tests 與 Live certification 未開始；status 保持 todo。
