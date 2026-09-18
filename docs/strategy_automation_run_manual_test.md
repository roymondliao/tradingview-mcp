# Strategy Automation Run Manual Test

本文件驗證`strategy run --config`從read-only preflight到Strategy sync、Parameter Sets、完整named Watchlist export與atomic artifacts的正式流程。

## Safety and prerequisites

- 使用Node.js 22以上版本。
- TradingView Desktop必須以CDP模式啟動並保持登入。
- 測試Layout使用exact name`dev`，Pane index為`0`。
- 測試Saved Strategy使用exact name`obv-v3`，local source為`data/obv-v3.pine`。
- 測試Watchlist使用exact name`dev-testing-list`。
- 正式run會依序處理Watchlist內每一個Symbol乘上每一個Parameter Set。執行前應先確認測試Watchlist大小；若只驗證流程，使用少量Symbols的專用Watchlist，避免意外啟動大型工作。
- 正式run可能建立或更新private Account Saved Strategy version，並安全refresh指定Pane Instance；不會Publish Pine Script。
- V1沒有retry、checkpoint或resume。中斷後需使用新的`run_id`重新開始。

## 1. Prepare a Run Config

可從以下範例複製：

```bash
cp changes/20260915_strategy_automation_run/run-config.example.json /tmp/tv-strategy-run.json
```

確認或修改：

- `run.run_id`：正式驗證建議明確指定唯一值，方便比對dry-run與formal run。
- `strategy.file`與`strategy.saved_name`。
- `target.layout.name`、`target.pane_index`與`target.watchlist.name`。
- `backtest.timeframe`。
- `experiments.parameter_sets`。
- `output.directory`與`output.format`。

Relative paths以config所在目錄解析。若config移到`/tmp`，應將Pine file與output directory改為absolute paths。

## 2. Read-only preflight

```bash
fnm exec --using=22 npm run tv -- strategy run \
  --config /tmp/tv-strategy-run.json \
  --dry-run
```

通過條件：

- `success`與`valid`皆為`true`。
- `blocked`與`errors`皆為空。
- Layout、Pane、Saved Strategy與Watchlist exact-name resolution正確。
- Watchlist Snapshot為`complete: true`，count符合TradingView Account內容。
- `strategy_sync.account_action`為`create`、`update`或`reuse`；`pane_action`為`add_latest`、`refresh`或`reuse`。
- 所有Parameter Sets通過Candidate validation；若Pane已是latest，也應顯示完整Runtime validation與Inputs fingerprint。
- Dry-run不得建立output directory、更新Pine、修改Inputs或切換Symbol。

## 3. Formal run

```bash
fnm exec --using=22 npm run tv -- strategy run \
  --config /tmp/tv-strategy-run.json
```

Formal run會重新執行完整preflight，不把先前dry-run當作cache。成功response只提供bounded counts、fingerprints與artifact paths，不在stdout列出完整Watchlist或所有Symbol明細。

Exit codes：

- `0`：所有Experiments與Symbols成功。
- `1`：validation failure、partial Symbol failure或其他一般錯誤。
- `2`：CDP connection failure，包含已發布partial run中出現CDP failure的情況。

## 4. Verify artifacts

```text
<output>/<run-id>/
├── run.json
├── watchlist.json
└── experiments/
    └── <parameter-set-name>/
        ├── experiment.json
        ├── manifest.json
        └── symbols/
            └── <safe-symbol>/
                ├── report.json
                ├── trades.json | trades.jsonl | trades.csv
                └── reconciliation.json
```

確認：

- `watchlist.json`保存完整ordered Symbols與原始Snapshot identity。
- 每個Experiment的manifest使用相同Watchlist Snapshot與固定Strategy revision。
- 每個成功Symbol同時具有Report、Trading Data與Reconciliation artifacts。
- `reconciliation.success`為`true`，且沿用總損益、勝率、總交易、獲利交易與虧損交易五項比對。
- `run.json`記錄resolved Layout／Pane／Strategy identity、source／schema／Inputs fingerprints、Experiment summary與final restore結果。
- Partial run仍會發布可檢查的terminal manifest；未完成Symbol不會留下被誤認為成功的partial artifacts。

## 5. Verify Desktop restoration

Formal run結束後確認：

- Strategy仍為sync後的latest Account version與同一個latest Pane `entity_id`。
- Strategy Inputs已恢復為batch開始時捕捉的Base Inputs。
- Chart Symbol與Timeframe已恢復為run開始時的值。
- 沒有新增額外的matching Strategy Instance。
- Parameter mutation的Report使用1秒polling interval，連續2次相同stable signature後才開始該Experiment export。

可再執行：

```bash
fnm exec --using=22 npm run tv -- tab list

fnm exec --using=22 npm run tv -- study list \
  --layout-id <layout-id-from-tab-list> \
  --pane-index 0 \
  --type strategy
```

再以回傳的`entity_id`檢查Inputs：

```bash
fnm exec --using=22 npm run tv -- study inputs get <entity-id> \
  --layout-id <layout-id-from-tab-list> \
  --pane-index 0
```

## 6. Collision behavior

使用相同explicit `run_id`再次執行formal run，必須在Strategy mutation前失敗並回傳`OUTPUT_ALREADY_EXISTS`。`strategy run`不提供`--force`，避免覆寫既有實驗結果。
