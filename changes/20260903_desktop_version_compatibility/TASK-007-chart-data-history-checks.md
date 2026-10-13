---
id: TASK-007
title: Chart, Main Series and history checks
status: todo
phase: desktop-version-compatibility
depends_on:
  - TASK-005
  - TASK-006
blocks:
  - TASK-008
  - TASK-012
  - TASK-013
scope: core-chart-data
---

# TASK-007: Chart, Main Series and history checks

## Goal

驗證 Chart runtime 與所有共享行情讀取所依賴的 Main Series 結構，並證明切換及載入完成語意仍成立。

## Dependencies and ownership

依賴：[TASK-005](./TASK-005-controlled-fixture-restore-promotion.md)、[TASK-006](./TASK-006-cdp-target-context-checks.md)。

本任務擁有的 Desktop check IDs：`CHART-001`、`DATA-001`、`HISTORY-001`。每個 check 的 read-only／controlled assertions 都在本任務交付（ENV 僅 metadata/preflight）。

遵循 [README 檢測清單](./README.md#required-validation-matrix)、[System Design](./SYSTEM_DESIGN.md)、[LLD](./LLD.md) 與 [共用交付規則](./README.md#task-delivery-contract)。

## Requirements

### In scope

- 讀 active wrapper/model、symbol/symbolExt/resolution/type/range；known fixture 上 identity 必須完整且一致。
- Controlled 切換 symbols/timeframes/type/range，驗證 setter readback/ready 後才讀新 context 資料，最後恢復。
- 驗證 bar indices/valueAt/size 與 time/OHLCV tuple、秒/ISO、finite numeric、ordering/dedupe；volume/Study warm-up nullable 按 fixture 規則。
- History 至少驗證一次 bounded progress 與合法 stop branch；no-progress/max-limit 不冒充 complete。
- 重用前項 context/restore coordinator；history bar cache 增長是宣告的 controlled effect，不要求 bar_count 回到原數字。
- Quote/stream/replay 共用 bars provider 不重複計分；不在此測 pollLoop 或 JSONL serializer。

### Out of scope

- 不匯出完整真實行情資料、不把可變市場價格與上一版本硬比、不重跑 Stream process tests 作 Desktop check。

## Design and deliverables

預計修改／新增：compatibility probes；src/core/chart.js、chart-session.js、data.js、src/wait.js。

優先比較 shape、身分與資料內部 invariants；分開 raw provider observation 與 normalized assertion，方便定位 API 變動。Progress fixture 不足只標該 assertion blocked。

Deliverables：上述實作、必要 fixtures/tests、registry/CLI wiring（適用時）與 completion evidence；不得只新增 stub 或只寫設計文件就標 done。

## Verification and Delivery

### Tests

- Symbol resolved mismatch、ready 偽完成、錯位 tuple、NaN/Infinity、秒/毫秒、合法 null、時間重複/逆序。
- History progress/no-more/no-progress/cap，無 progress fixture 不可 complete。
- Mutation timeout/readback failure 後 restore、bar cache growth restoration semantics。

### Acceptance criteria

- [ ] 所有三個 check 都驗證資料語意而非只確認方法存在。
- [ ] 切換後資料必須屬於新 pinned context，不能取舊資料當 pass。
- [ ] Report 說明 history 進度/停止與未涵蓋 assertions，restore 驗證原圖表選擇與範圍。

### Validation commands

以下是任務實作後的 target commands；新增 test files 需同步加入實際測試入口。目前不宣稱檔案或測試已存在。

```bash
fnm exec --using=22 node --test tests/compatibility_chart_data_checks.test.js tests/chart_history.test.js tests/data_history.test.js tests/chart_session.test.js
fnm exec --using=22 npm run lint
git diff --check
```

Live 驗證透過明確呼叫 `tv compatibility check --profile read-only --fixture <fixture.json>` 與 `--profile controlled` 執行；Replay 依契約加 opt-in。其他尚未實作的 checks 必須仍顯示 not_run，本任務可交付自己的 component evidence，但不能因此宣稱整體 passed。

## Completion record

Not started. 任務拆分完成不代表 runtime implementation 或 Live certification 完成。
