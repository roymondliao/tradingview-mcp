---
id: TASK-011
title: Strategy Trading regression and delivery gate
status: done
phase: strategy-trading
depends_on:
  - TASK-010
blocks: []
scope: local
---

# TASK-011: Strategy Trading regression and delivery gate

## Goal

整合並驗證CLI-first Strategy Trading vertical slices、formats、single-Symbol／Watchlist workflows與MCP parity，完成compatibility、documentation、安全Live evidence與release readiness；Gate不補實作缺少的feature behavior。

## Requirements

### In scope

- 稽核TASK-001～010 status與deliverables。
- 執行lint、unit、CLI、full deterministic regression與format golden tests。
- 驗證CLI／MCP inventory、Core reuse、errors、schemas與legacy behavior。
- 使用明確Pane／Strategy執行受控Live Report、multi-batch Data、single-Symbol與至少兩Symbol Watchlist smoke。
- 與TradingView Desktop download sample比較17類語意與五項reconciliation。
- 驗證staging／atomic publish與failure cleanup。
- 更新README、LLD、Terminology、guildeline、release notes與version decision。

### Out of scope

- 在Gate補齊前置Task漏掉的implementation。
- Community Scripts、OHLCV、Broker executions或parallel export。
- 修改／刪除使用者Saved Pine Scripts作為測試捷徑。

### Constraints and references

- [`Testing architecture`](./LLD.md#testing-architecture)
- [`Feature acceptance criteria`](./README.md#acceptance-criteria)

## Design

Gate只重跑正式commands與fixtures。Live validation使用read-only Strategy data與專用temporary output directory；任何外部限制記錄environment與evidence，不降低deterministic acceptance criteria。

## Verification and Delivery

### Tests

- Full unit／CLI／MCP／format／artifact／orchestration regressions。
- Multi-pane／multi-strategy／stale snapshot／partial failure scenarios。
- CLI help、exit codes、bounded stdout與no-hanging-process checks。
- Safe Live single-Symbol與Watchlist end-to-end validation。

### Acceptance criteria

- [x] TASK-001～010全部`done`且沒有blocking contract問題。
- [x] Feature README所有acceptance criteria有test或Live evidence。
- [x] JSON／JSONL／CSV canonical parity與Desktop semantic mapping通過。
- [x] Single-Symbol／Watchlist failures不發布錯誤artifacts。
- [x] CLI／MCP／legacy compatibility與docs一致。
- [x] Version／release impact已確認並記錄。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run test:all
npm run tv -- strategy --help
npm run tv -- strategy active
npm run tv -- watchlist get
```

### Deliverables

- Regression／Live evidence、completion records、updated docs、compatibility audit與release readiness result。

## Completion record

Completed on 2026-09-04.

- TASK-001～010 status、deliverables、Core ownership、CLI／MCP mapping與legacy compatibility已稽核。
- Node 22.16.0與Node 24.18.0的unit suites各398 passed；CLI suite 26 passed；full deterministic suite 398 passed。
- Lint為0 errors及3個既有unused-variable warnings；version sync、`v1.2.0`tag derivation、CLI version與package dry-run均通過。
- CLI help的subcommand欄寬改為依最長名稱計算，並新增不允許名稱／description黏連的regression assertion。
- Desktop 3.4.0 live validation完成Report、三批snapshot-stable Trading Data、single-Symbol CSV export及13-Symbol Active Watchlist export；13/13 Symbols成功且Chart restore通過。
- JSON／JSONL／CSV、17類Desktop semantics、五項reconciliation、staging／atomic publish、failure cleanup、partial／fail-fast與MCP bounded output均由deterministic tests覆蓋。
- `docs/guildeline.md`已改為CLI-first workflow；新增[`DELIVERY_EVIDENCE.md`](./DELIVERY_EVIDENCE.md)與[`RELEASE_NOTES.md`](./RELEASE_NOTES.md)。
- 此向後相容feature依SemVer決定為minor release，package與lockfile由1.1.0同步提升至1.2.0。

環境備註：使用預設`~/.npm`執行`npm pack --dry-run`時遇到repo外root-owned cache檔案；改用隔離的`--cache /tmp/tradingview-mcp-task011-npm-cache`後成功，未修改使用者cache權限。
