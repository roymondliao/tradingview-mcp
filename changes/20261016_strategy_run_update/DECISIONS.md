# Strategy Run Update — Decisions

## 1. 更新由使用者觸發，沒有日期或間隔參數

一天、一個月或 N 天都是使用情境。命令以執行當下 TradingView 可提供的結果為準，
實際回測起訖從 report 讀取；不把呼叫時間宣稱為行情截止時間。

## 2. 來源 durable artifacts 是設定依據

原 Config 可能已修改或遺失，當前 Watchlist 也可能不同。沿用已保存的完整實驗條件與
frozen Symbols，讓「更新資料」維持同一組實驗。策略或 universe 的調整另行建立 Run。

## 3. 每次更新建立新目錄並完整重跑

保留原分析依據，不覆寫成功來源。新結果包含完整 report、trades、reconciliation，
避免把最近交易直接附加而忽略歷史重算及未平倉交易變化。

## 4. Update 作為新的實驗集合 root

來源 Extension 的 ancestor 實驗全部實體執行並保存在 Update。來源關聯僅作 provenance，
後續 update/extend 不再次累加舊集合，也不因來源目錄移走而無法 resume。

## 5. 使用薄 adapter 與共用 execution lifecycle

Update 只負責來源驗證、規劃與新 Run 初始化；沿用既有 leases、session、retry、export、
restore 及 finalization，避免維護第二套執行／復原流程。

## 6. 新 metadata 使用 v5，保留既有 writer 行為

不能在 strict v4 下加入 `run_kind: "update"`。Update 與其 v5 Extension 後代使用 v5，
普通 Run／既有版本來源的 Extension 繼續使用 v4；讀取與 resume 支援 v2–v5，不遷移來源。

## 7. 補登需求與分支，不回寫已發生的開發順序

本次依使用者要求，在實作後補上 changes 文件並建立 feature branch；不宣稱需求文件先於實作。
依後續使用者要求，review 後將程式、測試與 Change 文件一起提交，不改寫既有歷史。


## 8. Resume 保留計算 Experiment ID 所用的原始 identity

既有 Experiment ID 的 hash 包含建立計畫時的 `entity_id`。TradingView 重啟後，Resume
可重新綁定 runtime entity，但不能把該值覆寫進原計畫的 persisted identity，否則下一次
Resume／Update 的 evidence validation 會拒絕原本有效的計畫。

`run.resolved.strategy` 保留原計畫 identity；實際 execution 與 CLI response 使用本次
重新綁定的 runtime strategy。既有 plans 與已成功 artifacts 保持不變。
