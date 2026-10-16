# Strategy Run Update — Implementation Review

Reviewed: 2026-10-16（Asia/Taipei）。
Scope: 本 feature 的程式、測試、CLI、artifact schema、lineage、共用 execution、Resume 與文件。

## Finding and fix

### P2 — Resume runtime rebinding invalidated persisted Experiment identity

- Trigger：Update 中斷後，TradingView 重啟使策略 entity ID 改變，再執行 Resume。
- 原行為：Resume 將新 runtime entity ID 寫入 `run.resolved.strategy`，但保留舊的
  `planned_experiments`。Experiment ID 的計算包含建立計畫時的 entity ID，因此下次
  Resume 或 Update 的 evidence validation 回傳 `RUN_RESUME_ARTIFACT_INVALID`。
- 重現：新增測試在第二次讀取 Resume artifacts 時，實際失敗訊息為
  `Experiment plan 0 ID is inconsistent.`。
- 修正：保留 persisted planning identity；重綁後的 strategy 傳給實際執行及 CLI response。
  不修改已保存的 Experiment IDs 或成功 Symbol artifacts。
- 回歸：Update interrupt → rebound Resume interrupt → 再次 Resume → Update dry-run 全部成功；
  並檢查實際 Symbol attempt 收到新的 runtime entity ID。
- 既有 Run 測試同步驗證 response 使用新 runtime ID、persisted planning identity 與 plans 不變。

## Additional coverage

- 真實 `resolveStrategyResumeIdentity()` 配合注入的 Desktop 邊界，驗證 Extension collection
  在 target/entity rebinding 且當前 inputs 屬於 ancestor experiment 時仍可 Update。
- Preflight 與取得 ownership 之間 runtime identity 改變時拒絕，釋放 lease 且不建立 output。
- Lineage depth 64 時，新增 Extension 仍被拒絕，而 Update 可讀取完整來源集合。

## Result and limits

修正後未發現其他阻擋本次提交的問題。最終測試及 lint 結果見
[Delivery evidence](./DELIVERY_EVIDENCE.md)。

本 review 為靜態檢查與本機自動化驗證；沒有執行真實 TradingView Desktop E2E，
不宣稱已驗證實際市場資料的新鮮度或 Desktop 整合結果。
