---
id: TASK-001
title: Strategy Trading runtime contract discovery
status: done
phase: strategy-trading
depends_on: []
blocks:
  - TASK-002
  - TASK-003
  - TASK-004
scope: active-pane
---

# TASK-001: Strategy Trading runtime contract discovery

## Goal

以安全的 Live probe 與 sanitized fixtures 固定 TradingView Strategy Report／Trade runtime contract，完成 LLD review gates，避免後續 implementation 猜測 raw keys、ordering、freshness、retention 或 compatibility semantics。

## Requirements

### In scope

- 盤點 `reportData()`、`reportData().trades`、active Strategy source 與 calculation state 的可用欄位。
- 建立 Desktop CSV 17 類語意對 raw payload 的 mapping table。
- 確認 raw Trade ordering、Open Trade representation、Trade total／retention 與 Regular／Deep Backtesting metadata。
- 確認 fresh／recalculating／ready／error 的 observable signals及 derived snapshot candidate fields。
- 固定 Trading Data batch default／maximum Limit。
- 固定 legacy commands、Watchlist failure、exit code、`--force`、diagnostic retention、JSONL metadata、CSV null、restore chart 與 backtest-mode policies。
- 產生去識別、bounded 的 deterministic fixtures並更新 LLD。

### Out of scope

- 實作正式 Trading Report／Data commands。
- 匯出使用者完整 private Strategy source 或 unrestricted runtime objects。
- 以 UI Download click 作為正式資料來源。

### Constraints and references

- [`TASK-001 contract decisions`](./LLD.md#task-001-contract-decisions)
- [`Runtime contract evidence`](./RUNTIME_CONTRACT.md)
- [`Desktop CSV semantic reference`](./README.md#desktop-csv-as-semantic-reference)
- Sample: [`data/trade_sample.csv`](../../data/trade_sample.csv)

## Design

Probe 只讀取明確 Strategy `entity_id` 的必要 raw shape、types、counts 與少量代表性 records。Fixtures 移除帳號、private source 與無關欄位；所有發現回寫 LLD，未能證明的欄位維持 unavailable contract，不以推測值補齊。

## Verification and Delivery

### Tests

- Sanitized raw fixture schema與 Desktop sample mapping tests。
- Regular／Deep metadata available／unavailable variants。
- Closed／Open、compact／verbose raw Trade variants。
- Unsupported raw schema failure fixture。

### Acceptance criteria

- [x] LLD review gates 全部有明確決策或正式 deferred contract。
- [x] Desktop CSV 17 類語意都有 raw key、derived rule或 unavailable 狀態。
- [x] Raw ordering、Trade retention與 complete-data判定可被 deterministic tests 表達。
- [x] Freshness與 snapshot candidate fields 有 Live evidence。
- [x] Fixtures 不含 private Pine source、cookies、credentials或 unrestricted raw objects。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run tv -- study list --type strategy
npm run tv -- strategy active
```

### Deliverables

- Updated LLD decisions、raw-to-canonical mapping、sanitized fixtures、runtime discovery notes與 targeted tests。

## Completion record

Completed on 2026-09-01.

- Added bounded live probe：`scripts/probe_strategy_trading_contract.js`。
- Added [`RUNTIME_CONTRACT.md`](./RUNTIME_CONTRACT.md)，固定 compact raw mapping、freshness、snapshot、retention、format、failure與restore policies。
- Added sanitized compact／verbose／unsupported／calculation-mode fixtures and 7 targeted contract tests。
- Live evidence observed `status.type` 2 → 1 → 2、Report ready → unavailable → ready、derived signature change，以及 subscribable report／status events。
- Live probe temporarily switched one Watchlist Symbol and confirmed original Symbol／Timeframe restored；final `study list --type strategy` and `strategy active` readback succeeded on the original context。
- `fnm exec --using=22 npm run lint`：0 errors，3 pre-existing warnings。
- `fnm exec --using=22 npm run test:unit`：263 passed，0 failed。
