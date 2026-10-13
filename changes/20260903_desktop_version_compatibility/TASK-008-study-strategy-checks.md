---
id: TASK-008
title: Study Inputs and Strategy lifecycle checks
status: todo
phase: desktop-version-compatibility
depends_on:
  - TASK-005
  - TASK-006
  - TASK-007
blocks:
  - TASK-011
  - TASK-013
scope: core-study-strategy
---

# TASK-008: Study Inputs and Strategy lifecycle checks

## Goal

驗證 Study Entity/metadata/Inputs 與 Strategy fresh Report/Trades 契約，涵蓋目前圖表與策略核心操作的最後兩組依賴。

## Dependencies and ownership

依賴：[TASK-005](./TASK-005-controlled-fixture-restore-promotion.md)、[TASK-006](./TASK-006-cdp-target-context-checks.md)、[TASK-007](./TASK-007-chart-data-history-checks.md)。

本任務擁有的 Desktop check IDs：`STUDY-001`、`STRATEGY-001`。每個 check 的 read-only／controlled assertions 都在本任務交付（ENV 僅 metadata/preflight）。

遵循 [README 檢測清單](./README.md#required-validation-matrix)、[System Design](./SYSTEM_DESIGN.md)、[LLD](./LLD.md) 與 [共用交付規則](./README.md#task-delivery-contract)。

## Requirements

### In scope

- getAllStudies/getStudyById/dataSources mapping、type/source/script/version、visibility/Input IDs/names/types/constraints/values。
- Test-owned Study add/remove、Input/visibility mutation-readback-restore；錯 Pane/Entity 不得猜測 fallback。
- Read-only 讀目前 active Strategy，不暗中 select；status/reportData/ordersData/performance/trades/equity/snapshot fields。
- Controlled 共用 Chart/Study mutation context 驗證 status lifecycle、freshness、stable reads、分頁 snapshot consistency、closed/open counts/order。
- Fixture 明確覆蓋足夠 trades/open-trade/empty-trade 分支；未涵蓋的 required assertion blocked。
- Evidence 僅保留必要 shapes/counts/fingerprints/status sequences；不含完整 Pine source 或交易明細。

### Out of scope

- 不跑完整 Run/Resume/Extend orchestration，不寫另一套 MCP Strategy checks，不以非空 Report 取代 freshness。

## Design and deliverables

預計修改／新增：compatibility probes；src/core/studies.js、strategy-runtime.js、strategy.js、strategy-trading.js。

同一 provider/observation 在相同 generation 可共用；Input/Symbol mutation 後必須重新讀取。Status 1/2 的變更只能透過已驗證 provider/fallback 處理，不在 Gate 猜新的 enum。

Deliverables：上述實作、必要 fixtures/tests、registry/CLI wiring（適用時）與 completion evidence；不得只新增 stub 或只寫設計文件就標 done。

## Verification and Delivery

### Tests

- Entity/source mismatch、unknown classification、Input ambiguous/type/range、visibility/inputs restore。
- Stale report、status shape change、缺 performance、report中途變化、paired trades/count/order mismatch、empty/open fixtures。
- Dependency blocked 與真實 contract failed 分類、ready + fresh + stable evidence 缺一不可。

### Acceptance criteria

- [ ] STUDY/STRATEGY required assertions 全部實作並透過共用 runner 執行。
- [ ] 既有 indicator 與 Strategy fixture 被正確分類；不會因 API wrapper 回 success 而假通過。
- [ ] Mutation 後證明 fresh calculation，分頁不能混用不同 snapshot。

### Validation commands

以下是任務實作後的 target commands；新增 test files 需同步加入實際測試入口。目前不宣稱檔案或測試已存在。

```bash
fnm exec --using=22 node --test tests/compatibility_study_strategy_checks.test.js tests/studies.test.js tests/strategy_runtime.test.js tests/strategy_trading_contract.test.js
fnm exec --using=22 npm run lint
git diff --check
```

Live 驗證透過明確呼叫 `tv compatibility check --profile read-only --fixture <fixture.json>` 與 `--profile controlled` 執行；Replay 依契約加 opt-in。其他尚未實作的 checks 必須仍顯示 not_run，本任務可交付自己的 component evidence，但不能因此宣稱整體 passed。

## Completion record

Not started. 任務拆分完成不代表 runtime implementation 或 Live certification 完成。
