# TradingView Desktop Version Compatibility Gate

Status: implemented; current configured Live validation tracked in [Delivery evidence](./DELIVERY_EVIDENCE.md).

## Objective

檢查 TradingView Desktop 升版後，CLI／MCP shared Core依賴的版本識別、CDP、必要Runtime APIs/providers、資源定位及資料契約是否仍成立。兩個入口共用同一組checks。

2026-10-14修訂：相容性Gate只做唯讀契約檢查。先前controlled的切換、增刪、Inputs修改、重新計算、restore／cleanup與Replay交易屬於專案E2E驗證；不列入report、不阻塞home passed，也不要求使用者跑E2E。

## Design documents

- [System Design](./SYSTEM_DESIGN.md)：入口、狀態、判定、精簡report與promotion。
- [LLD](./LLD.md)：模組、schema、runner、併發與CLI契約。
- [Runbook](./RUNBOOK.md)：實際設定與執行方式。
- [Delivery evidence](./DELIVERY_EVIDENCE.md)：版本tuple、測試證據、歷史scope變更與限制。

## Entry points and trigger

- 四個平台launch scripts與shared Core launch於CDP ready後重用/json/version response，觀察版本並更新home。
- 普通Desktop-dependent CLI command只讀本地state；未通過時stderr warning，仍執行原command，保留stdout／exit code。
- 使用者明確執行 `tv compatibility check` 才開始Gate；沒有TTL、背景檢測或每次command的live version query。
- 明確接受繞過launcher時可能使用舊observation；manual check會重新觀察live version。
- Gate所有適用唯讀assertions通過、前後版本/context/source穩定、report成功出版後，才更新passed。E2E成功不是前置條件。

## Fixture configuration

[config/compatibility/fixture.json](../../config/compatibility/fixture.json)指定實際測試資源：dev Layout／Pane0、dev-testing-list、dev-test-indicator、dev-test-strategy。名稱作辨識metadata，Study讀取使用已確認的entity IDs；移除／重新加入Study後需更新ID。

```bash
tv compatibility check --fixture config/compatibility/fixture.json
# --profile read-only 為可保留的明確寫法；沒有controlled profile。
```

`--fixture`接受其他JSON路徑，不自動載入／合併設定。Root欄位限schema_version、target、indicator、strategy、watchlist、graphics、drawing、exclude_checks。不含第二個Tab／Pane、mutation、Replay target或Editor source等E2E設定。

目前exclude_checks明確排除PINE-001、GRAPHICS-001、DRAWING-001。它們標記not_applicable／USER_SCOPE_EXCLUDED，不呼叫handler、不算passed；移除ID即可重新納入。六核心不能透過此欄位排除。

## Required validation matrix

Registry revision2：17 checks、37個唯讀assertions。目前排除7個assertions，適用30個。

| Component | Checks | 必要唯讀契約 |
| --- | --- | --- |
| Environment | ENV-001 | live Desktop版本與環境identity，前後穩定 |
| Core1：CDP／Runtime | CDP-001 | evaluate、awaitPromise、callFunctionOn JSON往返 |
| Core2：Target／Layout／Pane | TARGET-001、CONTEXT-001 | active target唯一、Saved Layout mapping、Pane ownership |
| Core3：Chart | CHART-001 | symbol／resolution／type／range及resolved symbol一致性 |
| Core4：Data／History provider | DATA-001、HISTORY-001 | OHLCV tuple、時間／finite／ordering、quote／Study values、history必要API |
| Core5：Study／Inputs | STUDY-001 | Entity/source mapping、Indicator／Strategy分類、Input IDs／types／values |
| Core6：Strategy | STRATEGY-001 | active source、完成狀態、Report／Trades／Equity必要shape及內部一致性 |
| Account | PINE-ACCOUNT-001、WATCHLIST-001、ALERT-001 | 已登入下inventory、指定Saved Pine source與完整Watchlist讀取；合法空inventory可接受 |
| Editor／UI | PINE-001、UI-001 | 已開Editor的Monaco model、canvas／CDP screenshot；Editor目前排除 |
| Feature providers | GRAPHICS-001、DRAWING-001、REPLAY-001 | 既有graphics primitives／Drawing properties及Replay必要methods/state；前兩組目前排除 |

檢測必要contract與可觀察資料，不比較完整private objects、不要求精確價格／盈虧固定。讀取使用目前active Pane／Strategy，不開面板、不切換選擇、不建立或刪除資產。

## Scope and report

成功代表目前設定範圍的必要唯讀契約相容，不保證所有操作／交易流程E2E成功，也不推論排除功能已通過。缺fixture與環境問題為blocked，必要contract可重現失敗才為incompatible；無舊版可比證據不歸因於Desktop升版。

Report schema3以版本／結果、issues、各check單一status與coverage counts呈現；不再有controlled／restore／next_check。成功只留status，異常保留reason／action，真正failure保留provider／expected／observed及影響入口。設定排除按check分組。詳細契約見[System Design](./SYSTEM_DESIGN.md#report-contract)。

Canonical report在 `~/.tradingview-mcp/compatibility/reports/`；state在同層state.json。--output是額外副本，覆寫須--force且不得寫入狀態目錄。舊report不改寫；舊registry與新scope不同時baseline標不可比。

## Project testing boundary

CLI／MCP wrapper/schema、serializer、atomic publication、lease/fencing、取消處理屬checker與Core的本地測試。操作生命週期／還原、history載入、Tab/Pane切換、Study/Account mutations、Strategy重新計算／分頁案例、UI互動、Replay交易屬E2E／回歸。它們都不是Desktop report assertions或home passed prerequisites。

原操作測試helpers移到tests/compatibility/support/desktop-operations.js、restore.js；設定範本移到tests/desktop/support/fixtures/operations.example.json。保留fake-driver回歸測試，不新增相容性CLI的操作入口；本次沒有執行live mutation E2E。

## Tasks

任務順序維持foundation→launch/advisory→registry/promotion→六核心／feature providers→整合。TASK-005與各component需求已依2026-10-14唯讀scope修訂。

| ID | Task | Checks | Depends on |
| --- | --- | --- | --- |
| [TASK-001](./TASK-001-version-identity-home-state.md) | Version identity and home state foundation | — | — |
| [TASK-002](./TASK-002-launch-version-observation.md) | Shared launch version observation | — | TASK-001 |
| [TASK-003](./TASK-003-cli-local-advisory-status.md) | Local-only CLI advisory and compatibility status | — | TASK-001 |
| [TASK-004](./TASK-004-checker-registry-report-cli.md) | Checker registry, report pipeline and read-only CLI | ENV-001 | TASK-001、TASK-003 |
| [TASK-005](./TASK-005-scope-and-verification-promotion.md) | Read-only scope and verification promotion | — | TASK-001、TASK-004 |
| [TASK-006](./TASK-006-cdp-target-context-checks.md) | CDP, Target, Layout and Pane checks | CDP-001 / TARGET-001 / CONTEXT-001 | TASK-004、TASK-005 |
| [TASK-007](./TASK-007-chart-data-history-checks.md) | Chart, Main Series and history checks | CHART-001 / DATA-001 / HISTORY-001 | TASK-005、TASK-006 |
| [TASK-008](./TASK-008-study-strategy-checks.md) | Study Inputs and Strategy lifecycle checks | STUDY-001 / STRATEGY-001 | TASK-005、TASK-006、TASK-007 |
| [TASK-009](./TASK-009-account-service-checks.md) | Account Pine, Watchlist and Alert checks | PINE-ACCOUNT-001 / WATCHLIST-001 / ALERT-001 | TASK-005、TASK-006 |
| [TASK-010](./TASK-010-editor-ui-checks.md) | Pine Editor and UI provider checks | PINE-001 / UI-001 | TASK-005、TASK-006 |
| [TASK-011](./TASK-011-graphics-drawing-checks.md) | Pine graphics and Drawing checks | GRAPHICS-001 / DRAWING-001 | TASK-005、TASK-006、TASK-008 |
| [TASK-012](./TASK-012-replay-checks.md) | Opt-in Replay lifecycle checks | REPLAY-001 | TASK-005、TASK-006、TASK-007 |
| [TASK-013](./TASK-013-integration-live-validation-delivery.md) | Integration, Live validation and delivery evidence | — | TASK-002、TASK-003、TASK-006、TASK-007、TASK-008、TASK-009、TASK-010、TASK-011、TASK-012 |

## Exit criteria

- Launch觀察版本；普通command local-only；manual Gate保持唯讀。
- 全部適用唯讀contract成立才compatible／passed，blocked或partial不冒充成功。
- Exclusions可追溯；source/version/context/generation fencing與atomic publication通過。
- CLI/MCP shared-provider coverage完整；本地測試與Desktop evidence分開。
- 精確平台／版本／來源tuple可重現；不把排除或未測平台視為認證。

## Completion record

2026-10-14：完成readonly scope修訂；原controlled操作移出registry／production Gate。Live30個適用assertions全部通過，home passed；7個explicit feature exclusions保留，沒有操作E2E前置。788 unit與13 error tests通過，lint0 errors。完整tuple/report/source與跨平台限制見Delivery evidence；本輪實作與驗收紀錄一併提交。
