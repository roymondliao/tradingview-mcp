---
id: FEATURE-20261016-STRATEGY-RUN-UPDATE
title: Strategy Run Update
status: done
created: 2026-10-16
depends_on:
  - FEATURE-20261007-STRATEGY-RUN-EXTENSION
  - FEATURE-20261008-COMPOSABLE-ERROR-HANDLING
scope:
  - refresh-existing-experiments
  - independent-update-run-directory
  - shared-durable-execution
  - artifact-schema-v5
---

# Strategy Run Update

Status: `done`（實作與本機自動化驗證完成；尚未執行 Desktop live 驗證或發佈）。

Feature branch：`codex/strategy-run-update`，由 `fork-main` 的
`e621874771f1f24ac10b83530d401e33fafb41d6` 建立。
本 Change 在功能實作後補登，記錄已確認的需求與實際交付內容；不改寫既有 Git 歷史。

## Feature request

使用者完成一次 `tv strategy run` 並分析全部 experiments 後，可能在一天、一個月或
任意 N 天後，需要取得同一組實驗的最新回測結果。時間間隔由使用者決定，不是設定欄位。

新增 `tv strategy update`，以指定成功 Run 保存的設定為準，在呼叫當下重新取得
TradingView 可提供的完整回測結果。使用者不必輸入日期、間隔或原始 Run Config。

| Command | Responsibility |
| --- | --- |
| `run` | 根據 Config 執行首次實驗集合。 |
| `resume` | 在同一 Run Directory 完成尚未成功的工作。 |
| `extend` | 新增 parameter sets，只執行新增實驗。 |
| `update` | 沿用已保存條件，完整重跑既有實驗集合。 |

## CLI and workflow

```bash
tv strategy update --run-directory ./output/<source-run-id> --dry-run
tv strategy update --run-directory ./output/<source-run-id>
tv strategy resume --run-directory ./output/<new-update-run-id>
```

- 唯一必要參數為 `--run-directory`；另支援 `--dry-run`。
- 來源必須是完整且 `succeeded` 的 durable Run；未完成者先使用 `resume`。
- 若來源是 Extension，更新截至該節點的完整 ancestor 實驗集合，不搜尋 sibling branches。
- 保留 strategy source/schema、base inputs、parameter sets、timeframe 及 frozen ordered Symbols。
- 原 Config 不必存在；原 Pine 檔案需仍在保存路徑且 hash 相同，當前 runtime identity 需符合來源。
- 每次正式執行建立新的 sibling output directory，舊結果與原分析保持原樣。
- Dry-run 不寫入 artifacts、不執行實驗；正式命令重新產生 Run ID，不沿用預覽 ID。

```text
output/
├── initial-run/                  # A、B，保留
├── extension-run/                # C，保留
└── strategy-update-<time>-<id>/   # A、B、C 全部重跑
    ├── run.json
    ├── watchlist.json
    └── experiments/
        ├── A/
        ├── B/
        └── C/
```

## Execution and compatibility contract

`strategy-update.js` 是 preflight／planning adapter，產生 `DurableRunExecutionSpec`，
再呼叫既有 `executePreparedDurableRun()`。Run／Pane leases、Chart session、Symbol validation、
retry、artifact publication、progress、finalization 與 restore 沿用共用流程。

Update 使用 artifact v5，寫入 `run_kind: "update"` 與來源 provenance，並保存完整實驗集合。
Update 是新的實驗集合 root；來源關聯不再計入繼承集合。因此重複 update 不增加實驗數，
且 Update 可獨立 resume、再次 update 或 extend。Extend 的 v5 後代持續使用 v5。

既有 v2／v3／v4 artifacts 保持可讀，來源不做 migration。一般 `run` 與以 v2／v3／v4
為來源的 `extend` 仍寫 v4。Config schema 維持 v1，Report／Trades 格式不變。

## Time and data semantics

Update 取得完整結果，不把最近 N 天交易附加到舊檔案；既有未平倉交易與歷史統計可能改變。
實際資料範圍以各 Symbol `report.json` 的 `calculation.range.backtest` 為準。
固定日期 inputs 或可用歷史資料可能使截止日不變、起始日向後移。Update 不修改日期 inputs，
不保證資料截止日等於系統時間，也不保證逐一匯出的 Symbols 共用同一行情快照。

## Scope

In scope：CLI、唯讀 preflight、完整實驗重建、新目錄、來源 provenance、v5 validation、
共用 execution、self-contained resume、chained update/extend、測試與文件。

Out of scope：排程、自動更新間隔、日期覆寫、策略或 Symbol universe 變更、增量交易合併、
跨版本績效比較／排名、自動分析、歷史行情快照、部署與發佈。

## Acceptance criteria

- [x] 不要求日期、間隔或原 Config；命令與 help 支援 `--run-directory [--dry-run]`。
- [x] Dry-run 無輸出寫入，每次正式呼叫產生新的 Run ID。
- [x] 所有既有 experiments × frozen Symbols 重新執行。
- [x] 更新 Extension 時包含 ancestor 實驗；多次更新不重複累加。
- [x] 建立獨立 sibling directory，保留來源 artifacts。
- [x] 沿用共用 durable execution；取得 ownership 後、建立目錄前再驗證來源與 runtime。
- [x] Update 中斷後可在來源目錄不存在時 resume，跳過該次已成功 Symbols。
- [x] 成功 Update 可再次 update 或 extend；來源 v2／v3／v4 相容。
- [x] 未完成／缺失／損壞來源、來源 Pine 變更及 output collision 均拒絕。
- [x] 本機自動化測試、CLI、lint 與 diff whitespace 檢查完成。

Desktop live 驗證尚未執行，不列為已通過的交付證據。

## Tasks and references

| Task | Status | Depends on |
| --- | --- | --- |
| [TASK-001: Artifact v5 and lineage](./TASK-001-artifact-v5-lineage.md) | `done` | Existing durable artifacts |
| [TASK-002: Update adapter and CLI](./TASK-002-update-adapter-cli.md) | `done` | TASK-001 |
| [TASK-003: Tests and documentation](./TASK-003-tests-documentation.md) | `done` | TASK-002 |

- [LLD](./LLD.md)
- [Decisions](./DECISIONS.md)
- [Delivery evidence](./DELIVERY_EVIDENCE.md)
- [Review and regression fix](./REVIEW.md)
- [Release notes](./RELEASE_NOTES.md)
- [Manual verification](../../docs/strategy_automation_run_manual_test.md#strategy-update刷新既有實驗)
