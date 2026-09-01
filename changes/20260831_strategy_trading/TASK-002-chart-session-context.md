---
id: TASK-002
title: Chart Session context and strict readback
status: todo
phase: strategy-trading
depends_on:
  - TASK-001
blocks:
  - TASK-003
  - TASK-005
  - TASK-006
scope: active-pane
---

# TASK-002: Chart Session context and strict readback

## Goal

建立長流程可重用的 Chart Session，固定 Tab／Layout／Pane context，嚴格驗證 Symbol／Timeframe mutation，並在使用者或其他 operation 改變 context 時明確失敗。

## Requirements

### In scope

- 新增 shared Core structured errors。
- 建立 `chart-session.js` 與 process-local Chart mutation mutex。
- 擴充 Pane assert／activate context與 Chart Symbol／Timeframe strict readback。
- Session 每個 phase revalidate target、layout、pane、symbol與 timeframe。
- Timeout／context change回傳 stable code、phase與 safe metadata。
- Dependency injection與 deterministic multi-tab／multi-pane tests。

### Out of scope

- Strategy Report freshness、Trade pagination或 file output。
- 阻止使用者操作 Desktop UI；只能偵測 interference。
- 跨 process distributed lock。

### Constraints and references

- [`New chart-session module`](./LLD.md#new-srccorechart-sessionjs)
- Existing `src/core/pane.js`、`src/core/chart.js`、`src/cli/pane-context.js`

## Design

CLI 解析 selectors 後將 immutable resolved context 傳入 Core。Session 在每個 phase reacquire／assert指定 Pane；Symbol／Timeframe timeout必須 throw，不可回傳 `success: true` 搭配 `chart_ready: false`。

## Verification and Delivery

### Tests

- Explicit Tab／Layout／Pane resolution、focus與readback。
- User switches active Pane during operation。
- Target closed、Layout changed、Pane ownership changed。
- Symbol／Timeframe success、timeout與wrong-readback。
- Mutex serializes same-process mutations。

### Acceptance criteria

- [ ] Long-running Core operation不依賴一次性的Active Pane focus。
- [ ] Wrong context或readback不會回傳success。
- [ ] Context errors包含stable code與phase。
- [ ] 既有 Pane／Chart commands regression不受影響。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run tv -- pane list
npm run tv -- state
```

### Deliverables

- Shared errors、Chart Session、strict readback、Pane／Chart integration與tests。

## Completion record

Not started.
