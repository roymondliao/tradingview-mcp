# Strategy Durable Export Recovery Manual Test

本文件驗證formal `strategy run` artifact v2的retry、same-run Resume、crash recovery、stable identity guard、cross-process lease及`stock_all_list` 652-Symbol capacity gate。Legacy `strategy trading-export`維持artifact v1且不支援Resume。

## Safety and prerequisites

- 使用Node.js 22，並另以CI目前使用的supported current Node line執行automated regression。
- TradingView Desktop必須以CDP模式啟動並保持登入。
- 使用專用Layout、Pane、Saved Strategy及小型Watchlist進行controlled scenarios；capacity gate才使用exact-name `stock_all_list`。
- 每個scenario使用新的explicit `run.run_id`，但同一scenario的Resume永遠沿用原Run Directory及Run ID。
- 先完成`--dry-run`。Dry-run不得建立Run Directory、修改Strategy／Inputs或切換Symbol。
- 中斷及Desktop restart測試會改變本機process狀態；不要在其他工作共用的Pane執行。
- 不提交User-specific absolute paths、Account資料或完整output artifacts。Acceptance record只保存sanitized IDs、counts、timings及error codes。
- Cleanup只刪除本次明確記錄的Run Directory；不要對output root使用recursive wildcard。

以下使用shell variables簡化指令；請替換成自己的明確路徑：

```bash
CONFIG=./temp/tv-strategy-durable-small.json
RUN_DIR=./temp/output/<run-id>
CAPACITY_CONFIG=./temp/tv-strategy-durable-stock-all.json
CAPACITY_RUN_DIR=./temp/output/<capacity-run-id>
```

## 1. Automated regression and benchmark

Durable-focused regression：

```bash
fnm exec --using=22 npm run test:durable
```

完整unit suite及lint：

```bash
fnm exec --using=22 npm run test:unit
fnm exec --using=22 npm run lint
```

再使用CI目前的supported current Node line執行相同`test:unit`。兩個Node lines都必須0 failures。

正式652 × 3 filesystem gate不連接Desktop，預設執行3次：

```bash
fnm exec --using=22 npm run benchmark:strategy-durable
```

通過條件：

- `shape.symbols: 652`、`parameter_sets: 3`、`symbol_executions: 1956`、`repetitions: 3`。
- 每次`symbols_succeeded: 1956`及`experiments_succeeded: 3`。
- `thresholds_enforced: true`，且process exit code為0。
- Output記錄Node／platform／filesystem、wall time、peak memory、logical bytes written、final disk bytes、manifest sizes及Resume planning latency。
- Script未加`--keep`時自動清除temporary Run artifacts。

`--measure`只供重新取得baseline，不是delivery gate，因為它不套用D-014量化thresholds。

## 2. Deterministic fault evidence

下表是LLD fault windows的automated evidence；test names是穩定的查核入口。

| Fault window | Evidence |
| --- | --- |
| Run Directory mkdir | `strategy_durable_fault_matrix.test.js`：mkdir failure映射為bounded `RUN_OUTPUT_INVALID`。 |
| Initial `watchlist.json`／`run.json` write | `strategy_durable_fault_matrix.test.js`：write failure不留下apparent commit或temporary file。 |
| JSON flush／rename | `strategy_run_artifacts.test.js`：`flush: true`、previous JSON preservation及temp cleanup。 |
| Manifest transition write | 上述atomic JSON tests加上`strategy_symbol_attempt.test.js`的manifest callback failure。 |
| Trade stream start／batch／finish／flush | `strategy_durable_fault_matrix.test.js`：三個failure points皆不publish final Symbol folder，且stream使用`flush: true`。 |
| Report／Reconciliation write | `strategy_durable_fault_matrix.test.js`：failure維持attempt-local且可abort。 |
| Symbol directory rename | `strategy_durable_fault_matrix.test.js`：完整staging不會被誤認成committed output。 |
| Rename後、manifest success callback前 | `strategy_symbol_attempt.test.js`：Resume cleanup後重跑，不信任folder presence。 |
| Final `run.json` replacement | `strategy_durable_fault_matrix.test.js`：保留前一份durable Run state。 |
| Lease acquire／reclaim／release | `strategy_run_lease.test.js`：live owner、dead PID、race、token mismatch、release ordering及symlink guards。 |
| First／second signal | `cli.test.js`與`strategy_run.test.js`：graceful AbortSignal、130／143 exit code及second-signal immediate exit。 |
| Attempt isolation | `strategy_durable_fault_matrix.test.js`：aborted attempt markers不會混入下一attempt。 |
| Succeeded skip／corruption rejection | `strategy_resume.test.js`及`strategy_run.test.js`：只選non-succeeded Symbols，缺漏／矛盾artifact拒絕Resume。 |

## 3. Prepare the small controlled config

從既有Run Config複製，設定專用small Watchlist及至少兩個Symbols。為縮短manual scenarios，先只保留一個`baseline` Parameter Set：

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

保留原Config中的`schema_version`、`strategy`、`backtest`及`output`欄位。每個scenario都複製一份config並換成新的explicit Run ID。

Read-only preflight：

```bash
fnm exec --using=22 npm run tv -- strategy run --config "$CONFIG" --dry-run
```

通過條件：`success: true`、`valid: true`、`blocked: []`、`errors: []`，且Snapshot count與small Watchlist一致；Run Directory尚不存在。

## 4. Normal successful Run

```bash
fnm exec --using=22 npm run tv -- strategy run --config "$CONFIG"
```

通過條件：

- Response為`success: true`、`status: "succeeded"`、`durable: true`。
- `retry_supported`與`resume_supported`皆為`true`。
- `run.json.status`及每個`manifest.json.status`皆為`succeeded`。
- 每個manifest entry為`succeeded`，且Report、Trades、Reconciliation三個paths均存在。
- Desktop的Strategy Inputs、Symbol與Timeframe完成restore。

成功Run再次Resume必須拒絕：

```bash
fnm exec --using=22 npm run tv -- strategy resume --run-directory "$RUN_DIR"
```

Expected error：`RUN_ALREADY_SUCCEEDED`。

## 5. Retry success and retry exhaustion

Production CLI沒有fault-injection flag。Retry classifier、attempt 2／3 success及exhaustion已由`test:durable`的explicit Core seams deterministic驗證；controlled live可用以下外部manual timing補充，但不得修改production retry constants：

1. 在專用Pane造成暫時、可復原的Symbol switch obstruction，例如開啟會短暫阻擋chart mutation的Desktop modal。
2. 啟動small Run，在第一個Symbol attempt失敗後、1s／2s backoff期間移除obstruction。
3. 成功案例確認該Symbol `attempt_count`為2或3且終態`succeeded`。
4. Exhaustion案例保持obstruction超過三次attempt；確認該Symbol為`failed`、`attempt_count: 3`，後續Symbol仍被執行，Run終態`failed`。
5. 移除obstruction後對同一Run Directory執行Resume；確認failed Symbol取得新的三次invocation budget，且先前`succeeded` Symbols的`attempt_count`、`updated_at`及artifact bytes沒有改變。

```bash
fnm exec --using=22 npm run tv -- strategy resume --run-directory "$RUN_DIR"
```

若Desktop版本無法可靠製造上述obstruction，記錄為`manual timing unavailable`，並以deterministic retry tests作為本項證據；不可加入hidden environment flag來偽造production結果。

## 6. Graceful interruption and same-run Resume

啟動包含至少兩個Symbols的Run。觀察第一個`manifest.json` entry成為`succeeded`後按一次`Ctrl-C`：

```bash
fnm exec --using=22 npm run tv -- strategy run --config "$CONFIG"
```

通過條件：

- CLI以130結束，response／`run.json.error.code`為`RUN_INTERRUPTED`。
- `run.json.status`為`failed`，已成功Symbol的manifest state及artifacts仍存在。
- Desktop restore完成；lease已釋放。

記錄已成功entry的`attempt_count`、`updated_at`及artifact byte sizes，再執行：

```bash
fnm exec --using=22 npm run tv -- strategy resume --run-directory "$RUN_DIR"
```

Resume必須沿用相同`run_id`，只執行non-succeeded Symbols。完成後比對先前成功entry與artifacts完全未變，Run達到`succeeded`。

## 7. Hard crash windows

### 7.1 Process crash after at least one success

啟動Run，第一個Symbol變成`succeeded`後，從另一個terminal對該CLI PID送出`SIGKILL`：

```bash
kill -9 <cli-pid>
```

Expected：`run.json`可能維持`running`，最後一個atomic manifest state保留。重新啟動Desktop/CDP（如有需要）後執行same-run Resume；已成功Symbol不得重跑。

### 7.2 Rename after, manifest callback before

這個window非常短，使用Node inspector的documented breakpoint，不修改production code：

```bash
fnm exec --using=22 node --inspect-brk src/cli/index.js strategy run --config "$CONFIG"
```

在`src/core/strategy-run-retry.js`中Symbol attempt `commit()`完成後、`attempt_succeeded` transition callback執行前設breakpoint。命中後確認final Symbol directory存在而manifest尚非`succeeded`，再對CLI PID送出`SIGKILL`。接著執行same-run Resume。

通過條件：Resume不因folder存在而推測成功；它只清除該non-succeeded Symbol的uncommitted final/staging output並重新執行。其他succeeded Symbols保持不變。

## 8. TradingView Desktop restart and identity guards

### Desktop restart rebind

在至少一個Symbol成功後強制結束TradingView Desktop，使Run因CDP error終止。以相同Account、Layout、Pane、Saved Strategy及CDP模式重新啟動Desktop，再執行Resume。

通過條件：volatile `target_id`、tab index及Strategy `entity_id`可重新綁定；same-run Resume完成，先前成功Symbols不重跑。

### Stable identity drift rejection

在另一個未完成Run上刻意改變一個stable identity，例如切換到不同saved Layout、改變Pane index、更新Saved Strategy source/version，或讓local Pine source hash改變，再執行Resume。

Expected：`RUN_RESUME_IDENTITY_MISMATCH`或對應既有identity/source guard；在任何Symbol mutation前拒絕，既有artifacts不變。完成後恢復原identity，再驗證Resume可繼續。

## 9. Duplicate Run and Pane ownership

保持第一個small Run正在執行時，在第二個terminal執行同一Run的Resume：

```bash
fnm exec --using=22 npm run tv -- strategy resume --run-directory "$RUN_DIR"
```

Expected：`RUN_ALREADY_ACTIVE`，且不修改Run artifacts。

再以不同Run ID但相同Layout／Pane啟動第二個formal Run；Expected同樣在mutation前以`RUN_ALREADY_ACTIVE`拒絕。不同Pane的Run不應被此Pane lease誤擋。

## 10. `stock_all_list` 652-Symbol capacity gate

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
- 記錄Snapshot ID及ordered Symbol fingerprint。

執行single-baseline endurance Run：

```bash
fnm exec --using=22 npm run tv -- strategy run --config "$CAPACITY_CONFIG"
```

若固定retry後仍有transient failure，禁止換新Run ID；修復Desktop/runtime狀況後明確Resume：

```bash
fnm exec --using=22 npm run tv -- strategy resume --run-directory "$CAPACITY_RUN_DIR"
```

Final acceptance：

- 相同Run ID的`run.json.status`為`succeeded`。
- baseline manifest為`succeeded`，summary為requested 652／succeeded 652／failed 0／pending 0。
- 652個entries全為`succeeded`，所有artifact verification通過。
- Resume前已成功Symbols未被重新export。
- Existing 448 × 3 manual result繼續作為multi-Parameter-Set live evidence；不執行652 × 3 live。

## 11. Legacy regression checks

重新執行既有manual cases：

- Formal `strategy run --dry-run`保持read-only。
- `strategy trading-export --symbol ...`保持v1 single-Symbol behavior。
- `strategy trading-export --watchlist active ...`保持v1 Active Watchlist behavior。
- Legacy exporter仍使用run-level transaction，不產生v2 Resume metadata。

Automated evidence位於`strategy_trading_export.test.js`、`strategy_trading_watchlist.test.js`及`strategy_run.test.js`。

## 12. Acceptance record and cleanup

只記錄以下sanitized evidence：

- 日期、TradingView Desktop version、Node versions、platform及filesystem type。
- Small test Layout／Pane／Strategy／Watchlist names。
- 各scenario的Run ID、Snapshot ID、Symbol／Experiment counts、terminal status及sanitized error codes。
- Retry的attempt count；interrupt／crash前後的succeeded count；Resume selected count。
- Volatile rebind前後IDs只需記錄「changed／unchanged」，不需提交Account-specific完整值。
- Capacity Run的652／652 summary及artifact audit結果。
- Automated suite counts、benchmark median／worst metrics及threshold result。

保留必要證據後，逐一刪除明確的測試Run Directory。若要使用shell cleanup，先輸出並人工核對exact path；不要使用未解析variable或wildcard。TradingView內的專用test Layout／Watchlist是否保留由測試環境owner決定。
