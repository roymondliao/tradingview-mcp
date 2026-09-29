# Known Issues

## KI-001: Strategy Symbol export 的共用邊界與命名不夠明確

### 現況

`strategy trading-export` 是 Strategy execution 中單一 Symbol Trading Report、Trading Data 與 Reconciliation 的原子匯出單位。TASK-003 已讓 legacy export 與 durable attempt 共用 `strategy-trading.js` 內相同的 runtime workflow，包括：

- Symbol／Timeframe 切換與 Strategy activation。
- Report A snapshot。
- 從 offset 0 開始分批取得完整 Trading Data。
- Report B snapshot。
- Snapshot validation 與 reconciliation。
- Report、Trades、Reconciliation artifact metadata 產生。

目前兩種執行模式的差異只在 artifact lifecycle：

- Existing `strategy trading-export` 使用 `createArtifactSetTransaction()`，保留 schema V1 manifest 與整組 artifacts 的 publish／abort 行為。
- Durable `strategy run`／`strategy resume` 使用 `createStrategySymbolAttemptArtifactWriter()`，將同一份 runtime workflow 的輸出寫入 attempt-owned staging，成功後再 atomic commit 至正式 Symbol Directory。

因此目前沒有重複實作 TradingView export、pagination、snapshot 或 reconciliation 邏輯。

### 已知問題

共用 workflow 目前以 `exportStrategySymbolIntoRun()` 表示，durable caller 則透過 `exportStrategySymbol({ _run: { artifact_writer } })` 注入 writer。這組命名與 `_run` private-shaped option 容易造成以下誤解或維護風險：

1. 容易誤以為 durable Symbol attempt 沒有重用 `strategy trading-export` 的 codebase。
2. `exportStrategySymbolIntoRun()` 的名稱無法準確表達它其實是 standalone export 與 durable attempt 共用的 Symbol export workflow。
3. `_run.artifact_writer` 將 orchestration context 與 storage adapter 混在公開函式的 options 中，module boundary 不夠清楚。
4. 後續修改者可能在 standalone 或 durable path 另外加入 runtime logic，導致兩條路徑產生行為差異。

### 建議改善

後續可在不改變 artifact schema 與 runtime behavior 的前提下，將共用層明確抽取並命名，例如：

```text
exportStrategySymbol()                    # standalone strategy trading-export wrapper
executeDurableStrategySymbolAttempt()     # durable run/resume attempt wrapper
              │
              └── executeStrategySymbolExport()  # 唯一共用 runtime workflow
```

建議的責任邊界：

- `executeStrategySymbolExport()`：只負責單一 Symbol 的 TradingView interaction、Report／Data retrieval、snapshot validation、reconciliation，以及透過明確的 artifact writer interface 寫入結果。
- `exportStrategySymbol()`：負責 standalone command 的 V1 transaction、manifest、publication、abort 與 chart restoration lifecycle。
- Durable attempt wrapper：負責 attempt staging、atomic directory commit，並由 retry executor／Experiment orchestrator 負責 manifest state transition。

Writer interface 可維持最小化：

```text
openTrades()
writeReport(value)
writeReconciliation(value)
artifactInfo()
```

### 影響範圍

- 這是 code organization、命名與介面清晰度問題，不是目前的資料正確性或 durability defect。
- TASK-003 已透過同一份 runtime workflow 與 regression tests 防止 export logic 分叉。
- 不影響既有 `strategy trading-export` schema V1 behavior。
- 不變更 durable artifact schema V2、retry policy、manifest state model 或 resume semantics。
- 若本 Change 期間未進行此重構，TASK-004／TASK-006 整合時必須繼續使用既有共用 workflow，不得另建第二套 Symbol export implementation。

### Resolution criteria

- Standalone 與 durable wrappers 明確呼叫同一個具名 Symbol export workflow。
- Durable integration 不再依賴 `_run.artifact_writer` 這類 private-shaped option。
- Existing standalone V1 與 durable V2 tests 均通過，且 Report／Data／Reconciliation runtime logic 只有一份實作。
