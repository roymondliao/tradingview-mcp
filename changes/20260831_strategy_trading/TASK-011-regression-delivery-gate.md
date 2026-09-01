---
id: TASK-011
title: Strategy Trading regression and delivery gate
status: todo
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

- [ ] TASK-001～010全部`done`且沒有blocking contract問題。
- [ ] Feature README所有acceptance criteria有test或Live evidence。
- [ ] JSON／JSONL／CSV canonical parity與Desktop semantic mapping通過。
- [ ] Single-Symbol／Watchlist failures不發布錯誤artifacts。
- [ ] CLI／MCP／legacy compatibility與docs一致。
- [ ] Version／release impact已確認並記錄。

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

Not started.
