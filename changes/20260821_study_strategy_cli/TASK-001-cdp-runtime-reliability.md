---
id: TASK-001
title: CDP Runtime reliability
status: done
phase: study-strategy-cli
depends_on: []
blocks:
  - TASK-002
  - TASK-003
  - TASK-005
  - TASK-006
scope: local
---

# TASK-001: CDP Runtime reliability

## Goal

讓所有依賴 TradingView Chart Runtime 的操作能可靠定位 Active Tab，並在 Target Discovery、Connect、Domain Enable、Evaluate 或 Chart Ready 無回應時於有限時間內回傳結構化 JSON Error。

## Requirements

### In scope

- 為 CDP lifecycle 各階段加入可設定 timeout 與 stable error stage。
- 透過 Desktop shell／visibility state 可靠解析 Active Chart Target，不依賴 `/json/list` 排序。
- Target 切換後更新 connection cache，避免後續 reads 仍指向舊 Tab。
- CLI 在 timeout 時輸出 JSON 並以一致 exit code 結束。
- 為 `docs/cmd_check.json` 中只有 npm banner、無 JSON 的案例建立 regression coverage。

### Out of scope

- Study classification、Pine Script lifecycle 或 Strategy Report behavior。
- 自動關閉、重新啟動或修改使用者既有 TradingView Tabs。
- 以 retry 永久掩蓋不可回復的 Runtime timeout。

### Constraints and references

- [`CLI command check`](../../docs/cmd_check.json)
- [`Study and Strategy CLI LLD`](./LLD.md#shared-runtime-rules)
- Existing connection implementation: `src/connection.js`

## Design

將 Target Discovery、WebSocket Connect、Domain Enable、Runtime Evaluate 與 Chart Ready 視為獨立 stages，使用有限 deadline 包裝並保留原始 cause。Active Target 由 Desktop shell state 與可回應 Chart target 共同驗證；錯誤 response 只暴露安全的 target/chart metadata。

## Verification and Delivery

### Tests

- 每個 CDP stage 的 success、timeout、disconnect 與 stale cache unit tests。
- Multi-tab Active Target selection、switch 與 background target tests。
- CLI timeout JSON、exit code 與無永久 pending regression tests。

### Acceptance criteria

- [x] `status`、`state` 與 Runtime-based Commands 不會永久等待。
- [x] 多 Tab 情境能定位 Desktop Active Chart Target。
- [x] 每個 timeout response 包含 stable code、stage 與 `timeout_ms`。
- [x] Target switch 後的下一個 Core call 使用新 Target。
- [x] `docs/cmd_check.json` 的 timeout baseline 有 deterministic regression test。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run tv -- status
npm run tv -- state
```

### Deliverables

- CDP timeout／target-selection implementation、shared error contract、unit／CLI tests，以及必要的 connection diagnostics documentation。

## Completion record

- Completed: 2026-08-21.
- Automated validation: `npm run test:unit` passed `176/176`; targeted connection／CLI tests passed `21/21`; `npm run lint` completed with no errors and four pre-existing warnings.
- Live validation: `npm run tv -- status` completed successfully in under one second and resolved the active `i3c6QVMw` Chart Target; `npm run tv -- state` returned Active Pane state without hanging.
- Runtime contract: Target Discovery、Connect、Domain Enable、Evaluate 與 Active Target Resolution 具有 bounded timeout；CLI CDP errors preserve `code`、`stage`、`timeout_ms` 與 safe target metadata。
- 2026-08-25 selector hardening: Active Target 優先由 renderer visibility/focus 解析，不再假設 Electron shell ordinal 等於 CDP target order；`tab list` 回傳 `url_chart_id`、Saved `layout_id/layout_name` 與 `pane_id`，Pane-scoped CLI/MCP operations 支援明確 Tab/Layout/Pane selectors。
