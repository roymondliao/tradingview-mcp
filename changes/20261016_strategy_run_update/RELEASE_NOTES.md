# Strategy Run Update — Release Notes

Target release: `1.6.0`（待 PR 合併及 release workflow 發佈）。

- 新增 `tv strategy update --run-directory <source> [--dry-run]`，不必提供日期或原 Config。
- 完整重跑來源實驗集合與 frozen Symbols，在獨立目錄保存結果，保留歷史分析依據。
- 支援 Extension 集合更新、Update 獨立 Resume、再次 Update 與後續 Extend。
- Update 與其 Extension 後代使用 artifact v5；既有 v2／v3／v4 保持可讀且不做 migration。

另修正 Resume 在 runtime entity ID 改變後覆寫 planning identity 的問題，避免後續
Resume／Update 誤判 Experiment ID 不一致。

原 Pine 檔案與匹配的 TradingView runtime 仍是必要條件。實際回測資料範圍以 report 為準，
不因呼叫 Update 而自動改寫固定日期 inputs。

本機測試已通過；尚未執行 Desktop live 驗證或發佈。
