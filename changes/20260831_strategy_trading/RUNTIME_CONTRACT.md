# Strategy Trading Runtime Contract

Status: `discovered`

## Evidence scope

本文件記錄 TASK-001 在 2026-09-01 對 TradingView Desktop 3.3.0 的受控 CDP discovery 結果。Probe 使用明確的 Tab、Pane 與 Strategy `entity_id`，只回傳 bounded keys、types、counts、數值 shape 與 redacted strings；沒有讀取 Pine source、cookies、credentials 或完整 private runtime objects。

可重現指令：

```bash
fnm exec --using=22 node scripts/probe_strategy_trading_contract.js \
  --entity-id <entity-id> \
  --tab-index <tab-index> \
  --pane-index <pane-index>
```

Freshness probe 可選擇 Watchlist 中另一個 Symbol。它會在同一 page context 訂閱 state events、暫時切換 Symbol，然後在 `finally` 還原原始 Symbol：

```bash
fnm exec --using=22 node scripts/probe_strategy_trading_contract.js \
  --entity-id <entity-id> \
  --tab-index <tab-index> \
  --pane-index <pane-index> \
  --switch-symbol <different-symbol>
```

Committed fixtures 全部使用 synthetic symbol、times、prices、labels 與 metrics；live numeric results、帳號資訊及 Strategy 名稱沒有寫入 repository。

## Runtime shape

### Strategy source

- Active Strategy 必須從 resolved Pane 的 `internalModel.dataSources()` 以 `entity_id` 找到。
- `activeStrategySource().value()` 可驗證該 source 是否為 Strategy Tester 的 current source。
- `reportData()` 在本次 Desktop build 直接回傳 plain object，沒有 `.value()`。
- `performance()`、`ordersData()`、`status()`、`calculationTime()`、`reportChanged()` 與 `onStatusChanged()` 均存在。
- `reportChanged()` 與 `onStatusChanged()` 回傳可訂閱 object；事件只作 polling wake-up signal，不作 snapshot identity。

### Report

Observed top-level keys：

```text
buyHold
buyHoldPercent
currency
filledOrders
firstTradeIndex
marginUsage
performance
settings
trades
```

`performance.all` 至少提供本 feature 所需的：

```text
netProfit
percentProfitable
totalTrades
totalOpenTrades
numberOfWiningTrades
numberOfLosingTrades
```

`settings.dateRange` observed shape：

```js
{
  backtest: { from, to },
  trade: { from, to }
}
```

這些 timestamps 與 Trade leg timestamps 都是 Unix milliseconds。後續 canonical output 必須保留 numeric milliseconds，並使用 `unixMillisecondsToIso()` 產生 ISO companion；不得使用 `unixSecondsToIso()`。

本次 build 沒有在 Report 或 Strategy source 上觀察到可信的 generation ID、Regular／Deep mode discriminator 或 version field。`calculationTime()` 在兩次 Symbol calculation 之間維持相同，不能用於 freshness 或 snapshot identity。

## Compact Trade shape

Observed paired Trade：

```js
{
  e:  { b, c, p, tm, tp },
  x:  { b, c, p, tm, tp },
  q,
  v,
  tp: { v, p },
  cm,
  rn: { v, p },
  dd: { v, p },
  cp: { v, p }
}
```

Leg type values observed為 `le`／`lx`；future adapter 同時保留 `se`／`sx` compatibility。Localized或使用者自訂 signal text 位於 `c`，可以輸出但不可用於欄位辨識、Open／Closed classification 或 snapshot signature。

Metric pair 中的 `p` 是 ratio；canonical `*_percent` 與 Desktop CSV percentage column 使用 `raw.p * 100`。Raw precision 必須保留到 reconciliation／encoding boundary。

### Desktop CSV semantic mapping

| # | Desktop semantic | Compact raw source | Canonical rule | Availability |
| --- | --- | --- | --- | --- |
| 1 | Trade number | `report.firstTradeIndex` + array index | `firstTradeIndex + index + 1` | available |
| 2 | Entry／Exit type | `e.tp`／`x.tp` | map `le/lx/se/sx`; Open 使用 report counts | available |
| 3 | Date and time | `e.tm`／`x.tm` | Unix ms + UTC ISO companion | available |
| 4 | Signal | `e.c`／`x.c` | preserve value; empty Open mark label is valid | available |
| 5 | Price | `e.p`／`x.p` | preserve raw precision | available |
| 6 | Size quantity | `q` | paired Trade quantity | available |
| 7 | Size value | `v` | position value | available |
| 8 | Net profit | `tp.v` | report currency | available |
| 9 | Return percent | `tp.p` | multiply ratio by `100` | derived |
| 10 | Commission | `cm` | report currency | available |
| 11 | Favorable excursion | `rn.v` | run-up value | available |
| 12 | Favorable excursion percent | `rn.p` | multiply ratio by `100` | derived |
| 13 | Adverse excursion | `dd.v` | drawdown value | available |
| 14 | Adverse excursion percent | `dd.p` | multiply ratio by `100` | derived |
| 15 | Cumulative profit | `cp.v` | report currency | available |
| 16 | Cumulative profit percent | `cp.p` | multiply ratio by `100` | derived |
| 17 | Duration bars | `x.b - e.b` | non-negative integer difference | derived |

Verbose compatibility keys already supported by existing normalizers remain valid fallback inputs，例如 `entry`／`exit`、`quantity`、`profit`、`commission`、`runup`、`drawdown` 與 `cumulativeProfit`。若 compact 與 verbose required keys 都無法辨識，必須回傳 `TRADING_DATA_SCHEMA_UNSUPPORTED`，不可猜測。

## Ordering, Open Trades and completeness

- `report.trades` observed ordering 是 Entry time oldest-first。
- `performance.all.totalTrades` 是 Closed Trade count，不包含 Open Trades。
- `performance.all.totalOpenTrades` 是 Open Trade count。
- Live evidence observed `report.trades.length === totalTrades + totalOpenTrades`。
- Open Trades 排在 Closed Trades 後方。Observed Open Trade 仍有 synthetic `x` price、time、bar index、type 與 mark-to-market metrics，但 `x.c` 為空；因此不得用「是否存在 `x`」判斷 Open／Closed。
- Canonical Open Trade 的 `exit` 必須是 `null`，raw `x` 投影為 `mark`，避免將尚未成交的 mark-to-market value 誤稱實際 Exit。
- `firstTradeIndex` 是 retained result 的起始 index。只有 `firstTradeIndex === 0` 才能宣告從第一筆開始完整取得；Trade number 為 `firstTradeIndex + array index + 1`。
- 沒有觀察到另一個 Trade load-more／history API。Offset／Limit 只對同一份 in-memory `report.trades` 做 slice。

完整資料 success gate：

```text
firstTradeIndex === 0
report.trades.length === totalTrades + totalOpenTrades
Entry time oldest-first
all batches share one snapshot
offset traversal reaches report.trades.length
```

任一條件不成立都回傳 incomplete／unsupported error，不得將 retained tail 或 count gap 包裝成 success。

## Freshness evidence

Symbol switch 的 bounded timeline observed：

```text
t=0 ms    requested Symbol 暫時 readback；status=2；舊 Report 仍可讀；舊 signature
t≈100 ms  resolved Symbol alias；status=1；Report unavailable
t≈300 ms  status=2；Report ready；新 signature
```

Switch + restore 共觀察到 `reportChanged` 與 `statusChanged` events。還原原 Symbol 後，原 signature 再次穩定出現。

重要 contract：

- `chart.symbol() === requested` 加上 `report.performance` 可讀，仍不足以證明 fresh；t=0 已反例證明會讀到舊 Report。
- Mutated Symbol／Timeframe／Inputs 必須觀察 `status.type === 1`、Report unavailable、`reportChanged`／`statusChanged`，或 derived signature change，之後才接受 `status.type === 2` 且 stable 的新 Report。
- Same-Symbol 且 Timeframe／Inputs 未變時不強制 `recalculate()`；接受 current Report，但 derived signature 必須連續 3 次穩定，poll interval `200 ms`。
- Default calculation timeout `20,000 ms`；timeout 不以舊 Report fallback。
- `status.type` 是 internal build-specific signal：本次 observed `1 = calculating`、`2 = ready`。Unknown value 一律不視為 ready。
- `calculationTime()` 不作 freshness gate。
- TradingView resolved symbol 可能將 `TWSE:*` canonicalize 為 `TWSE_DLY:*`。TASK-002 必須以 resolved symbol identity／approved alias normalization 驗證，並在 response 同時保留 requested 與 resolved symbols。

## Snapshot schema version 1

本次 build 沒有 generation ID，因此 v1 使用 stable canonical JSON 的 SHA-256 derived signature。欄位固定為：

```text
target_id / layout_id / pane_id
Strategy entity_id
requested symbol / resolved symbol
timeframe
Strategy Inputs fingerprint
calculation mode availability + value
settings.dateRange.backtest.from / to
settings.dateRange.trade.from / to
currency
firstTradeIndex
report.trades.length
closed / open counts
five reconciliation Report metrics
first Trade identity
last Trade identity
```

Trade identity 使用 report index、Entry／Exit-or-mark timestamps、bar indexes、leg types、prices與quantity；不使用 localized labels。Snapshot schema version、field list與normalization rules都必須進入hash input，避免未來schema變更碰撞。

## Resolved policy decisions

1. **Legacy commands**：`strategy select/report/trades` 與 `data strategy/trades` 第一版保留為 deprecated compatibility surface；不被新 workflow 呼叫、不宣告 snapshot-complete，於下一個 major version 才可移除。
2. **Batch limit**：`offset` default `0`；`limit` default `500`、maximum `5000`。Slice 必須在 page context 執行；export internal batch 也使用 default `500`。
3. **Same-Symbol**：未發生 context mutation 時接受 stable current Report；200 ms polling、連續 3 次相同 derived signature。發生 mutation 時必須證明 transition或signature change。
4. **Generation／snapshot**：generation ID unavailable；使用 snapshot schema v1 derived SHA-256。`reportChanged`只作 wake-up，`calculationTime`排除。
5. **Ordering／Open／retention**：oldest-first；Open由 report counts與trailing position辨識；`firstTradeIndex !== 0`視為retained tail，不能宣告完整。
6. **Watchlist failure**：default continue-on-error；提供 `--fail-fast`。任一 Symbol failed 時 CLI final exit code `1`；CDP connection failure維持 `2`。
7. **Output transaction**：existing final target default error；`--force`只在新staging已驗證完成後替換明確target。Failed staging default cleanup，只在manifest保留bounded error；不保存raw runtime dump。
8. **JSONL／CSV**：JSONL第一行 `record_type=metadata`、中間 `record_type=trade`、最後一行 `record_type=summary`。CSV使用UTF-8 without BOM、comma、RFC 4180 quoting、LF newline；`null`輸出為empty unquoted field。
9. **Backtest mode**：第一版不切換Regular／Deep；只記錄runtime明確提供的active mode。沒有explicit discriminator時輸出`mode: unknown`及availability limitation；`dateRange`不能推測mode。
10. **Chart restore**：第一版在command／run的`finally`恢復原Symbol與Timeframe；Watchlist run只在整個run結束時恢復一次。沒有`--no-restore`。Restore失敗必須進manifest並使command失敗。

## Deterministic fixtures

- [`compact-report.json`](../../tests/fixtures/strategy-trading/compact-report.json)：sanitized Desktop compact shape、Closed + trailing Open、freshness evidence。
- [`verbose-report.json`](../../tests/fixtures/strategy-trading/verbose-report.json)：supported verbose-key compatibility shape。
- [`unsupported-report.json`](../../tests/fixtures/strategy-trading/unsupported-report.json)：required keys無法辨識。
- [`calculation-mode-variants.json`](../../tests/fixtures/strategy-trading/calculation-mode-variants.json)：Regular／Deep explicit metadata與unavailable policy variants。

Fixtures 不代表完整 TradingView objects，只保存後續 deterministic adapter tests 所需的最小 contract。
