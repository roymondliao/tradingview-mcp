---
id: TASK-003
title: Complete Named Watchlist Snapshot
status: done
phase: strategy-automation-run
depends_on: []
blocks:
  - TASK-004
  - TASK-007
scope: account-watchlist
---

# TASK-003: Complete Named Watchlist Snapshot

## Goal

交付`watchlist snapshot --name`，以Account detail source取得完整、ordered且stable的named Watchlist Symbols，取代不完整的virtualized DOM rows作為Strategy automation工作集合。

## Requirements

### In scope

- Account Watchlist list／detail adapters與exact-name resolution。
- Stable two-read、bounded retry、count／modified／fingerprint comparison。
- Declared／returned／unique／invalid／duplicate completeness validation。
- Immutable canonical Snapshot、Unix／ISO capture time與SHA-256 identity。
- `watchlist snapshot --name [--output] [--force]`CLI與atomic JSON output。
- Extend`watchlist list`metadata與`watchlist get`的`complete: false`diagnostic。
- Add`watchlist_snapshot`MCP tool with bounded response behavior。

### Out of scope

- UI scroll fallback或Active Watchlist switching。
- Watchlist create／rename／delete。
- Strategy export、retry或resume。

### References

- [`Complete Watchlist Snapshot`](./WATCHLIST_SNAPSHOT.md)
- [`LLD Watchlist module`](./LLD.md#extend-srccorewatchlistjs)
- `stock_list`live evidence：declared／Account／React 448，DOM 37。

## Design

Named Snapshot以same-origin Account source為primary provider，React runtime只在同一Watchlist active時作optional cross-check。DOM source永遠不可回傳`complete: true`。Two-read在有限次數內無法穩定則`WATCHLIST_SNAPSHOT_UNSTABLE`；provider／schema不可用則structured unsupported，不fallback為假成功。

## Verification and Delivery

### Tests

- Exact one／none／duplicate name resolution。
- Detail response shape、ordered Symbols與count parity。
- Stable／changed／eventually stable two-read sequences。
- Invalid、duplicate、separator與empty Watchlist cases。
- Fingerprint determinism與captured time ISO。
- Provider unavailable／timeout／unexpected schema。
- CLI stdout、atomic output、existing target與`--force`。
- `watchlist get`明確不完整與MCP parity。

### Acceptance criteria

- [x] Snapshot不依賴DOM或UI切換即可取得named Watchlist。
- [x] 只有count、identity與stable reads全部通過才回傳`complete: true`。
- [x] `stock_list`live readback與ordered fingerprint驗證通過；實作驗證時Account內容已由原規劃的448筆更新為449筆，inventory／detail／unique皆為449。
- [x] Large response可寫入JSON file，stdout維持machine-readable。
- [x] Internal endpoint變動不會靜默回傳部分資料。

### Validation commands

```bash
fnm exec --using=22 npm run lint
fnm exec --using=22 npm run test:unit
fnm exec --using=22 npm run test:cli
fnm exec --using=22 npm run tv -- watchlist snapshot --name stock_list
```

### Deliverables

- Named Watchlist Core adapter／snapshot、CLI／MCP、atomic output、tests與live evidence。

## Completion record

Completed on 2026-09-16.

- 新增exact-name Account resolution、same-origin detail adapter、two-consecutive-read stability與bounded retry。
- 完整性驗證涵蓋declared／returned／unique count、invalid／duplicate Symbols與Section filtering；provider／schema異常回傳structured error，不fallback至DOM。
- Snapshot提供immutable ordered Symbols、Unix／ISO capture time、ordered fingerprint與deterministic snapshot ID。
- CLI支援`watchlist snapshot --name [--output] [--force]`；完整JSON使用single-file atomic transaction，file output stdout維持bounded summary。MCP`watchlist_snapshot`只回傳metadata與首尾sample。
- Live read-only：`stock_list`449筆，fingerprint`sha256:097ca617f74a1697841bfa2f4f2fc0cf04167e50b19c80cd9a8d86a1b1b301ea`；`dev-testing-list`448筆，fingerprint`sha256:f05d6578c44a6e0c6375b84d6a7589d2714ac38668cdfde36d426dc4ce25caaf`。兩者皆stable reads 2、invalid 0、duplicate 0、complete true，且Account標示non-active，證明不依賴Active Watchlist切換。
- Validation：targeted Watchlist／CLI 57 passed、full unit 443 passed、CLI 30 passed、lint 0 errors（3個既有warnings）。
