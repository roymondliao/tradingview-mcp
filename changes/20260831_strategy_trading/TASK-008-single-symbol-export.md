---
id: TASK-008
title: Single-Symbol Strategy Trading export
status: done
phase: strategy-trading
depends_on:
  - TASK-005
  - TASK-006
  - TASK-007
blocks:
  - TASK-009
scope: active-pane
---

# TASK-008: Single-Symbol Strategy Trading export

## Goal

交付`strategy trading-export <entity-id> --symbol <symbol>`，在同一Symbol Session內取得Report A、完整Trading Data、Report B、完成五項reconciliation並atomic發布artifacts。

## Requirements

### In scope

- 建立`exportStrategySymbol()`唯一single-Symbol workflow。
- 新增`strategy trading-export --symbol`CLI surface。
- 迭代所有Trade batches並stream至selected encoder。
- Report A／batches／Report B snapshot一致性驗證。
- Streaming aggregates與pure reconciliation parity。
- 輸出report、trades、reconciliation與single-run manifest。
- Failure phase、diagnostics、cleanup與CLI exit behavior。

### Out of scope

- Watchlist iteration或parallel Symbols。
- MCP parity、OHLCV或Broker executions。

### Constraints and references

- [`Single-Symbol export flow`](./LLD.md#single-symbol-export)
- TASK-005～007 vertical slices。

## Design

Application Service只prepare一次Symbol Session。它不呼叫低階CLI subprocess，而是重用Report／batch Core functions。任何pagination、snapshot或reconciliation failure都abort transaction，不發布final Symbol directory。

## Verification and Delivery

### Tests

- Single／multi-batch happy paths與zero-trade strategy。
- Report A／B mismatch與mid-batch stale snapshot。
- Reconciliation pass／fail與Open／Breakeven cases。
- JSON／JSONL／CSV artifacts與manifest paths。
- Encoder／filesystem failure cleanup。
- CLI required args、summary與exit code。

### Acceptance criteria

- [x] 一個command完成單一Symbol的Report與完整Trading Data匯出。
- [x] 所有artifacts屬於同一snapshot。
- [x] 五項metrics全部matched才publish成功。
- [x] Failure不留下看似完整的final output。
- [x] 三種Trading Data formats產生相同reconciliation結果。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run tv -- strategy trading-export --help
```

### Deliverables

- Single-Symbol application service、CLI、artifact set、tests與manual validation guide。

## Completion record

Completed on 2026-09-03.

- Added `exportStrategySymbol()` application service。單一Chart Session內依序固定Report A、以oldest-first Offset／Limit讀取全部Trade batches、stream寫入selected encoder、讀取Report B，並驗證所有資料使用同一snapshot。
- Added streaming five-metric accumulator，與既有pure array calculation採用相同Closed／Open／Breakeven及commission規則；只有Report B的總損益、勝率、總交易數、獲利交易數與虧損交易數全數matched才允許發布。
- Added atomic artifact-set transaction。整個run tree先寫入同filesystem staging directory；Chart restore成功後才一次rename為final run directory。Snapshot、pagination、reconciliation、encoder、filesystem或restore failure均清除staging，不留下final output；`--force`在新run驗證完成前保留舊目錄。
- Added `strategy trading-export <entity-id> --symbol <exchange:symbol> --output <directory> [--timeframe] [--format json|jsonl|csv] [--force]`。stdout只回傳bounded run summary，不包含完整Trades。
- Final run layout固定為`<output>/<run-id>/manifest.json`及`symbols/<safe-symbol>/{report.json,trades.<format>,reconciliation.json}`；manifest保留requested／resolved Symbol、snapshot、artifact paths、summary counts、timestamps及Chart restore結果。
- Tests涵蓋single／multi-batch、zero Trades、JSON／JSONL／CSV parity、Report A/B mismatch、mid-batch stale、reconciliation mismatch、encoder failure、restore failure、staging cleanup、atomic directory publish／force及CLI validation。
- `fnm exec --using=22 npm run test:unit`：382 passed，0 failed。
- `fnm exec --using=22 npm run test:cli`：25 passed，0 failed。
- `fnm exec --using=22 npm run lint`：0 errors，3 pre-existing warnings。
- Live TradingView Desktop 3.4.0：成功以URL Chart ID定位Pane，匯出單一TWSE Symbol的11筆paired Trades（10 Closed、1 Open）；四個artifacts使用同一snapshot，五項metrics全部matched，Unix millisecond／ISO companion與bounded stdout均確認正確，Chart restore readback成功。
- Follow-up context hardening：Tab與Pane改用共用Layout Identity adapter；`tab list`已在三個Live Tabs解析runtime／Saved Layout IDs與Pane metadata，並分別以`--layout-id`及`--saved-layout-id`成功取得相同Strategy context。

### Manual validation

```bash
# 1. 找出Pane context與Strategy entity_id
fnm exec --using=22 npm run tv -- strategy active

# 2. 匯出單一Symbol；多Tab時建議明確提供url-chart-id與pane-index
fnm exec --using=22 npm run tv -- strategy trading-export <entity-id> \
  --symbol TWSE:2344 \
  --url-chart-id <url-chart-id> \
  --pane-index 0 \
  --output ./strategy-exports \
  --format json

# 3. stdout的output.path是final run directory；檢查manifest與reconciliation
jq '{status, summary, symbols, chart_restore}' \
  ./strategy-exports/<run-id>/manifest.json
jq '{success: .reconciliation.success, mismatched: .reconciliation.mismatched_metrics}' \
  ./strategy-exports/<run-id>/symbols/TWSE_u3A_2344/reconciliation.json
```
