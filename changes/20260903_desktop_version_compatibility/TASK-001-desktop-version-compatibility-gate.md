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

## Requirements

### In scope

- 建立 versioned compatibility check registry，每個 check 具有 stable ID、required flag、profile、timeout、result status 與 bounded evidence contract。
- 收集 Desktop／CDP／OS／Node／repo environment tuple；Desktop exact version 無法自動判斷時要求明確 CLI input 並記錄 source，不猜測版本。
- 建立公開 Desktop-dependent CLI／Core surface inventory，要求每個 surface 映射至 required 或具有明確 entitlement／fixture precondition 的 check。
- 實作 `compatibility check` 的 `read-only` 與 `controlled` profiles，並支援 atomic JSON `--output`／`--force`。
- 驗證 CDP、Target、Tab／Layout／Pane、Chart、Data、Study、Strategy、History、Watchlist、Pine、Drawing、Alert、Replay、UI、Stream、Output 與 repository regression contracts。
- Controlled profile 在 mutation 前建立 immutable restore context，成功或失敗都嘗試恢復，並對 restore 結果 readback。
- 將 environment、fixture、optional capability 與 confirmed Desktop incompatibility 分開分類。
- Required check 失敗時輸出失敗 contract、provider path、expected／observed shape、最後已知相容版本與 sanitized diagnostic；不輸出 unrestricted runtime data。
- 為已知 Desktop 3.3.0／3.4.0 Layout identity 差異建立 regression case：legacy `_prevChartState.id` 不可作為唯一來源；3.4.0 runtime `layout_id` 由 `_saveChartService.layoutId()` 取得，account `saved_layout_id` 由 Saved Layout catalog mapping 取得。
- 建立 support matrix 與每次認證的 completion evidence template。

### Out of scope

- 自動升級或降級 TradingView Desktop。
- 在 CI 啟動已登入的真實 Desktop session。
- 對 unknown runtime object 執行 unrestricted recursive dump。
- 將 Community Scripts、Broker execution、entitlement-only capability 或尚未公開支援的 feature 升格為 required checks。
- Gate 內直接加入未經 review 的 version-specific workaround。
- 為了完成測試修改或刪除使用者既有 Saved Layout、Watchlist、Pine Scripts 或 Studies。

### Constraints and references

- [`Compatibility Gate design`](./README.md)
- [`TradingView MCP Terminology Definition`](../../docs/terminology.md)
- [`Study and Strategy CLI LLD`](../20260821_study_strategy_cli/LLD.md)
- [`Strategy Trading runtime contract`](../20260831_strategy_trading/RUNTIME_CONTRACT.md)
- Existing CDP lifecycle: [`src/connection.js`](../../src/connection.js)
- Existing safe Core errors: [`src/core/errors.js`](../../src/core/errors.js)
- Existing Desktop launch scripts: [`scripts/`](../../scripts)

## Design

### Module boundaries

```text
CLI: compatibility check
  -> Compatibility application service
       -> versioned check registry
       -> existing Core read/mutation adapters
       -> restore coordinator
       -> result classifier
       -> sanitized evidence builder
       -> existing atomic artifact transaction
```

CLI 只負責 parse／validate arguments、呼叫 application service 與輸出 bounded summary。Check 不得啟動低階 CLI subprocess；應直接重用既有 Core modules，使未來 shell 與 MCP 都能使用同一 contract。

### Execution stages

1. **Preflight**：記錄 environment，驗證 CDP、登入狀態、fixture prerequisites 與 bounded timeout。
2. **Read-only checks**：執行所有不改變 Desktop state 的 required checks。
3. **Restore snapshot**：Controlled profile 固定 target／layout／pane／symbol／timeframe／study identities。
4. **Controlled checks**：只使用已核准 fixture 執行 mutation＋readback。
5. **Restore**：在 `finally` 恢復並驗證；restore failure 使整體結果失敗。
6. **Regression**：執行 deterministic tests；Live checker 只記錄 command 建議，不在 page runtime 內啟動 shell。
7. **Classification**：依 required failures 與 preconditions 產生 overall status。
8. **Publish**：完整 report atomic publish；stdout 只輸出 bounded summary。

### Failure semantics

- Required contract missing／shape changed：`DESKTOP_VERSION_INCOMPATIBLE`。
- CDP／process／login／permission unavailable：`COMPATIBILITY_ENVIRONMENT_BLOCKED`。
- 測試 Layout／Strategy／Watchlist／history data 不足：`COMPATIBILITY_FIXTURE_BLOCKED`。
- Controlled state 無法恢復：`COMPATIBILITY_RESTORE_FAILED`。
- Check timeout：保留 check ID、stage、`timeout_ms`，且不得讓後續 process 永久 pending。
- Optional capability unavailable：記錄 `unsupported_optional`，不影響 overall compatibility；既有公開 CLI contract 不可標記為 optional。

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

- Registry completeness：每個 required matrix ID 都有 implementation，ID 不重複且 timeout 有上限。
- Public surface coverage：每個 Desktop-dependent CLI command／Core adapter 都映射至 check，新增 command 未登錄時 test 失敗。
- Result classification：compatible、incompatible、environment blocked、fixture blocked、optional unsupported。
- Environment collection與 unavailable metadata。
- Desktop 3.3.0 legacy／3.4.0 runtime Layout identity fixtures。
- Read-only profile 無 mutation；controlled profile success／mid-operation failure／restore failure。
- Sanitization：不洩漏 cookies、tokens、完整 Pine source、帳號 private payload 或 unrestricted objects。
- Atomic output、existing target／`--force`、write failure cleanup與 bounded stdout。
- CLI help、argument validation、exit codes與 no-hanging-process。
- Live smoke：多 Tab、Saved Layout mapping、Pane ownership、Strategy Report／Trades、History、Watchlist、disposable Pine／Study cleanup。

### Acceptance criteria

- [ ] `compatibility check --profile read-only` 可在升版後安全產生完整 required check report。
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
fnm exec --using=22 npm run tv -- compatibility check --profile read-only --output compatibility.json
fnm exec --using=22 npm run tv -- compatibility check --profile read-only --desktop-version 3.4.0 --output compatibility.json
fnm exec --using=22 npm run tv -- compatibility check --profile controlled --output compatibility-controlled.json
```

Repository gate：

```bash
fnm exec --using=22 npm run lint
fnm exec --using=22 npm run test:unit
fnm exec --using=22 npm run test:cli
fnm exec --using=22 npm run test:all
git diff --check
```

在 target command 尚未實作前，Live baseline 至少包含：

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

- Compatibility check registry與Core application service。
- CLI command、versioned JSON report schema與atomic output。
- Environment／fixture／runtime classifiers與safe diagnostics。
- Desktop Layout legacy／current fixtures及完整 deterministic tests。
- Live runbook、support matrix、completion evidence與相關 terminology／runtime documentation updates。

## Completion record

Not started.
