# Strategy Automation Run Manual Test

本文件驗證`strategy run --config`從read-only preflight到Strategy sync、Parameter Sets、完整named Watchlist export、durable artifacts、fixed retry及same-run `strategy resume`的正式流程。

Strategy Automation Run的TASK-008 automated gate已完成deterministic regression、完整448-Symbol Watchlist read-only preflight，以及`TWSE:2330`×兩組Parameter Sets的bounded formal代表案例。Durable Export Recovery的automated fault matrix與652 × 3 filesystem benchmark也已完成；下列手測用來驗證真實TradingView Desktop retry／Resume與`stock_all_list` 652-Symbol capacity gate。

## Safety and prerequisites

- 使用Node.js 22以上版本。
- TradingView Desktop必須以CDP模式啟動並保持登入。
- 測試Layout使用exact name`dev`，Pane index為`0`。
- 測試Saved Strategy使用exact name`obv-v3`，local source為`data/obv-v3.pine`。
- 測試Watchlist使用exact name`dev-testing-list`。
- Durable controlled scenarios應另外使用至少2個Symbols的專用small Watchlist，避免每個crash scenario重跑448筆。
- Capacity gate才使用exact name`stock_all_list`，expected count為652，並且只執行一個`baseline` Parameter Set。
- 正式run會依序處理Watchlist內每一個Symbol乘上每一個Parameter Set。執行前應先確認測試Watchlist大小；若只驗證流程，使用少量Symbols的專用Watchlist，避免意外啟動大型工作。
- 正式run可能建立或更新private Account Saved Strategy version，並安全refresh指定Pane Instance；不會Publish Pine Script。
- Formal Run artifact v2具備固定Symbol retry與same-run `strategy resume`。Legacy `strategy trading-export`仍維持artifact v1且不支援Resume。
- 每個scenario使用新的explicit `run.run_id`；同一scenario的Resume必須沿用原Run Directory與Run ID，不得建立continuation Run。
- 中斷及Desktop restart測試只能在專用Pane進行，不要與其他工作共用。
- 不提交User-specific absolute paths、Account資料或完整output artifacts；只保存sanitized IDs、counts、timings及error codes。

## 1. Prepare a Run Config

可從以下範例複製：

```bash
cp changes/20260915_strategy_automation_run/run-config.example.json ./temp/tv-strategy-run.json
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
  --config ./temp/tv-strategy-run-positive.json \
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
  --config ./temp/tv-strategy-run-positive.json
```

Formal run會重新執行完整preflight，不把先前dry-run當作cache。成功response只提供bounded counts、fingerprints與artifact paths，不在stdout列出完整Watchlist或所有Symbol明細。

Exit codes：

- `0`：所有Experiments與Symbols成功。
- `1`：validation failure、partial Symbol failure或其他一般錯誤。
- `2`：CDP connection failure，包含已發布partial run中出現CDP failure的情況。
- `130`：收到第一次`SIGINT`並完成graceful durable finalization。
- `143`：收到第一次`SIGTERM`並完成graceful durable finalization。

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

使用相同explicit `run_id`再次執行formal run，必須在Strategy mutation前失敗並回傳`RUN_OUTPUT_EXISTS`。`strategy run`不提供`--force`，避免覆寫既有實驗結果。

## 7. Automated evidence boundary

以下項目已由deterministic tests驗證，不需要透過破壞真實Run Directory重測：

```bash
fnm exec --using=22 npm run test:durable
```

| Fault window | Automated evidence |
| --- | --- |
| Run Directory mkdir與initial JSON write | Failure會轉成bounded error，不留下apparent commit或temporary file。 |
| JSON flush／rename | 使用same-directory temporary file與`flush: true`；rename failure保留前一份state。 |
| Trade stream start／batch／finish | Failure不publish final Symbol folder。 |
| Report／Reconciliation write | Failure只影響attempt staging，可安全abort。 |
| Symbol directory rename | 完整staging不會被誤認成committed output。 |
| Manifest success callback | Rename後callback失敗不會回報Symbol成功。 |
| Final `run.json` update | Replacement失敗時保留前一份durable Run state。 |
| Lease reclaim／release | Live owner、dead PID、race、token mismatch與release ordering均有測試。 |
| Attempt isolation | Aborted attempt的marker不會混入下一attempt。 |
| Corruption rejection | Manifest為`succeeded`但artifact缺漏／矛盾時拒絕Resume，不會silent rerun。 |

正式652 × 3 filesystem gate可選擇重新執行；它不連接Desktop，預設執行3次：

```bash
fnm exec --using=22 npm run benchmark:strategy-durable
```

通過條件為`thresholds_enforced: true`、每輪1956/1956 Symbol executions成功，且process exit code為0。`--measure`不套用D-014 thresholds，不能作為delivery gate。

## 8. Prepare durable controlled configs

以下shell variables只作為後續指令縮寫，請替換成實際明確路徑：

```bash
SMALL_CONFIG=./temp/tv-strategy-durable-small.json
SMALL_RUN_DIR=./temp/output/<small-run-id>
CAPACITY_CONFIG=./temp/tv-strategy-durable-stock-all.json
CAPACITY_RUN_DIR=./temp/output/<capacity-run-id>
```

從既有positive Config複製small config，設定專用small Watchlist並只保留一個`baseline` Parameter Set：

```json
{
  "run": {
    "run_id": "durable-small-<timestamp>",
    "description": "durable recovery controlled live test"
  },
  "target": {
    "layout": { "name": "dev" },
    "pane_index": 0,
    "watchlist": { "name": "<dedicated-small-watchlist>" }
  },
  "experiments": {
    "parameter_sets": [
      { "name": "baseline", "inputs": {} }
    ]
  }
}
```

保留原Config中的`schema_version`、`strategy`、`backtest`及`output`欄位。每個controlled scenario複製一份config並使用新的explicit Run ID。

先驗證small config：

```bash
fnm exec --using=22 npm run tv -- strategy run \
  --config "$SMALL_CONFIG" \
  --dry-run
```

通過條件：`success: true`、`valid: true`、`blocked: []`、`errors: []`，Snapshot count與small Watchlist一致，且Run Directory尚未建立。

## 9. Normal durable Run and succeeded-Run guard

```bash
fnm exec --using=22 npm run tv -- strategy run --config "$SMALL_CONFIG"
```

除了第3～5節的通過條件外，另確認：

- Response為`success: true`、`status: "succeeded"`、`durable: true`。
- `retry_supported`與`resume_supported`皆為`true`。
- `output.atomic`為`false`，`atomic_scope`為`state_file_and_symbol_directory`。
- `run.json.status`與每個`manifest.json.status`皆為`succeeded`。
- 每個manifest entry為`succeeded`且Report、Trades、Reconciliation三個paths均存在。

成功Run不得再次Resume：

```bash
fnm exec --using=22 npm run tv -- strategy resume \
  --run-directory "$SMALL_RUN_DIR"
```

Expected error：`RUN_ALREADY_SUCCEEDED`。

## 10. Retry success and retry exhaustion

Production CLI沒有fault-injection flag。Attempt 2／3 success、retry exhaustion、fresh Resume budget與continue-next-Symbol已由第7節的explicit Core seams deterministic驗證。Controlled live可用外部manual timing補充，不得修改production retry constants：

1. 在專用Pane造成暫時、可復原的Symbol switch obstruction，例如開啟會短暫阻擋chart mutation的Desktop modal。
2. 啟動small Run，在第一個Symbol attempt失敗後的1s／2s backoff期間移除obstruction。
3. 成功案例確認該Symbol `attempt_count`為2或3且終態為`succeeded`。
4. Exhaustion案例保持obstruction超過3次attempt；確認該Symbol為`failed`、`attempt_count: 3`，後續Symbol仍有執行，Run終態為`failed`。
5. 記錄先前成功Symbols的`attempt_count`、`updated_at`及artifact byte sizes。
6. 移除obstruction並Resume相同Run Directory；failed Symbol會取得新的固定3-attempt invocation budget，先前成功Symbols不得改變。

```bash
fnm exec --using=22 npm run tv -- strategy resume \
  --run-directory "$SMALL_RUN_DIR"
```

若目前Desktop版本無法可靠製造retryable obstruction，記錄為`manual timing unavailable`並保留deterministic retry tests作為證據；不可新增hidden environment flag來偽造production結果。

## 11. Graceful interruption and same-run Resume

使用至少2個Symbols的small config啟動Run。觀察第一個`manifest.json` entry成為`succeeded`後按一次`Ctrl-C`：

```bash
fnm exec --using=22 npm run tv -- strategy run --config "$SMALL_CONFIG"
```

通過條件：

- CLI以130結束，response與`run.json.error.code`皆為`RUN_INTERRUPTED`。
- `run.json.status`為`failed`，已成功Symbol的manifest state及artifacts仍存在。
- Desktop restore完成，Run／Pane lease已釋放。

記錄已成功entry的`attempt_count`、`updated_at`與artifact byte sizes，再執行：

```bash
fnm exec --using=22 npm run tv -- strategy resume \
  --run-directory "$SMALL_RUN_DIR"
```

Resume必須沿用相同`run_id`，只執行non-succeeded Symbols。完成後比對先前成功entry及artifacts完全未變，Run達到`succeeded`。

若要驗證`SIGTERM`，使用另一個新Run並對CLI PID送出一次`SIGTERM`；Expected exit code為143，其他行為與`SIGINT`相同。

## 12. Hard crash recovery

### 12.1 Process crash after at least one success

啟動新Run，第一個Symbol成為`succeeded`後，從另一個terminal對該CLI PID送出`SIGKILL`：

```bash
kill -9 <cli-pid>
```

Expected：`run.json`可能維持`running`，最後一個atomic manifest state保留。重新啟動Desktop/CDP（如有需要）後，對相同Run Directory執行Resume；已成功Symbol不得重跑。

### 12.2 Crash after Symbol rename and before manifest callback

這個window非常短，使用Node inspector的documented breakpoint，不修改production code：

```bash
fnm exec --using=22 node --inspect-brk src/cli/index.js \
  strategy run --config "$SMALL_CONFIG"
```

在`src/core/strategy-run-retry.js`的`await attempt.commit()`完成後、`persist(succeeded, 'attempt_succeeded')`執行前設breakpoint。命中後確認final Symbol directory存在而manifest尚非`succeeded`，再對CLI PID送出`SIGKILL`。

接著執行same-run Resume。通過條件：

- Resume不因folder存在而推測成功。
- 只清除該non-succeeded Symbol的uncommitted final／staging output並重新執行。
- 其他succeeded Symbols的state與artifacts保持不變。

## 13. TradingView Desktop restart and identity guards

### 13.1 Desktop restart and volatile rebind

在至少一個Symbol成功後強制結束TradingView Desktop，使Run因CDP error終止。使用相同Account、Layout、Pane、Saved Strategy及CDP模式重新啟動Desktop，再執行Resume。

通過條件：volatile `target_id`、tab index與Strategy `entity_id`可重新綁定；Resume沿用相同Run ID並完成，先前成功Symbols不重跑。

### 13.2 Stable identity drift rejection

在另一個未完成Run上刻意改變一個stable identity，例如：

- 切換到不同saved Layout。
- 改變Pane index。
- 更新Saved Strategy source／version。
- 修改local Pine source使hash改變。
- 將Strategy Inputs改成不屬於Base或任何persisted Parameter Set的值。

執行Resume，Expected為`RUN_RESUME_IDENTITY_MISMATCH`或對應既有identity／source guard，且必須在Symbol mutation前拒絕並保持既有artifacts不變。恢復原identity後，再驗證Resume可繼續。

## 14. Duplicate Run and Pane ownership

保持第一個small Run正在執行時，在第二個terminal執行同一Run的Resume：

```bash
fnm exec --using=22 npm run tv -- strategy resume \
  --run-directory "$SMALL_RUN_DIR"
```

Expected：`RUN_ALREADY_ACTIVE`且不修改Run artifacts。

再以不同Run ID但相同Layout／Pane啟動第二個formal Run；Expected同樣在mutation前以`RUN_ALREADY_ACTIVE`拒絕。不同Pane的Run不應被此Pane lease誤擋。

## 15. `stock_all_list` 652-Symbol capacity gate

Capacity config必須使用exact-name `stock_all_list`且只保留一個`baseline` Parameter Set。先執行：

```bash
fnm exec --using=22 npm run tv -- strategy run \
  --config "$CAPACITY_CONFIG" \
  --dry-run
```

Snapshot通過條件：

- `watchlist.watchlist.name`為`stock_all_list`。
- `declared_symbol_count`、`returned_symbol_count`及`unique_symbol_count`皆為652。
- `invalid_symbol_count: 0`、`duplicate_symbol_count: 0`、`complete: true`。
- 記錄Snapshot ID與ordered Symbol fingerprint。

執行single-baseline endurance Run：

```bash
fnm exec --using=22 npm run tv -- strategy run --config "$CAPACITY_CONFIG"
```

若固定retry後仍有transient failure，禁止換新Run ID；修復Desktop／runtime狀況後明確Resume：

```bash
fnm exec --using=22 npm run tv -- strategy resume \
  --run-directory "$CAPACITY_RUN_DIR"
```

Final acceptance：

- 相同Run ID的`run.json.status`為`succeeded`。
- Baseline manifest summary為requested 652／succeeded 652／failed 0／pending 0。
- 652個entries全為`succeeded`，所有artifact verification通過。
- Resume前已成功Symbols未被重新export。
- Existing 448 × 3成功結果繼續作為multi-Parameter-Set live evidence；不執行652 × 3 live。

## 16. Legacy exporter regression

確認下列既有操作未受artifact v2影響：

- Formal `strategy run --dry-run`保持read-only。
- `strategy trading-export --symbol ...`保持artifact v1 single-Symbol behavior。
- `strategy trading-export --watchlist active ...`保持artifact v1 Active Watchlist behavior。
- Legacy exporter不產生artifact v2 Resume metadata，亦不接受`strategy resume`。

## 17. Manual acceptance record and cleanup

完成手測後，記錄：

- 測試日期、TradingView Desktop version、Node version與OS／architecture。
- Config path、explicit Run ID與output directory的sanitized reference。
- Layout／Pane／Strategy／Watchlist names。
- Snapshot ID、Symbol count與ordered fingerprint。
- 每個scenario的terminal status、sanitized error code、attempt count及Resume selected count。
- Interrupt／crash前後的succeeded count，以及先前成功artifacts是否未變。
- Formal Run的Experiment數與每個Experiment requested／succeeded／failed Symbols。
- 所有成功Symbol是否具有Report、Trading Data及`reconciliation.success: true`。
- Final Desktop readback：Account version、Pane entity identity是否rebound、Inputs fingerprint、Symbol、Timeframe及matching Instance count。
- Capacity Run的652/652 summary及artifact audit結果。

只保存bounded evidence，不提交完整Symbols、Trades、User-specific absolute paths或Account secrets。若發生partial／failure，保存對應manifest error code與phase；不得手動修改manifest或拼接artifact來製造成功結果。

保留必要證據後，逐一刪除明確記錄的測試Run Directory。執行cleanup前先輸出並人工核對exact path；不要對output root使用recursive wildcard、未解析variable或寬泛路徑。

全部controlled live與652 capacity acceptance完成並回填後，才可將`changes/20260926_strategy_durable_export_recovery/TASK-007-regression-benchmark-live-gate.md`及Feature status改為`done`。
