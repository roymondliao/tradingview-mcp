# Strategy Run Update — Delivery Evidence

Recorded: 2026-10-16（Asia/Taipei）。
Status: implementation and local validation complete; no live Desktop validation or release.

## Branch and scope

- Feature branch: `codex/strategy-run-update`。
- Branch base: `fork-main` at `e621874771f1f24ac10b83530d401e33fafb41d6`。
- 實作先完成，後依使用者要求補建分支與本 Change；review 後將程式、測試與文件納入同一 feature commit，未推送。
- Review 修正 Resume runtime rebinding 問題；以下 full-suite 結果來自修正後重新執行，其餘檢查亦記錄實際結果。

## Automated validation

| Command | Observed result |
| --- | --- |
| `npm run test:all` | 813 tests passed, 0 failed, 0 skipped; 132 suites（review 修正後重跑）。 |
| `npm run test:cli` | 44 tests passed, 0 failed。 |
| `node --test tests/strategy/run/integration/update.test.js tests/strategy/run/unit/lineage.test.js` | 18 tests passed，涵蓋 14 個 Update 與 4 個 lineage tests。 |
| `npm run lint` | 0 errors；3 個既有 warnings，位於 `src/core/data.js` 與 `src/tools/watchlist.js`。 |
| `git diff --check` | Passed。 |
| `node src/cli/index.js strategy update --help` | 顯示 `--run-directory` 與 `--dry-run`。 |

補登時讀取的 Node 版本：`v26.5.1`。未宣稱 Node 22／24 matrix 已執行。

## Feature-specific evidence

`tests/strategy/run/integration/update.test.js` 包含 14 個 tests：

- 無原 Config 的 dry-run、不寫入 output、每次產生新 ID。
- 完整 experiments × Symbols 重跑、新 sibling 目錄、來源 run.json 不變。
- Extension collection 更新、重複 Update、Update 後 Extend，沒有重複實驗。
- 移走來源後 Resume，只補未成功 Symbols。
- Runtime entity rebinding 後多次 Resume，計畫仍可驗證，完成後可 Update。
- 真實 identity resolver 驗證 Extension ancestor inputs 與 target/entity rebinding。
- Ownership 前 runtime identity 改變時拒絕並釋放 lease，不建立 output。
- 歷史 v3／v4 來源更新後保持原格式；其餘 fixture 亦覆蓋 v2 與新 v5。
- 真實 identity resolver 拒絕已修改或遺失的 Pine source。
- 未完成／缺失來源在 runtime access 前被拒絕。
- CDP errors 保留、已知 identity errors 翻譯、未知錯誤 fallback。
- Output collision 不覆寫、不進行 runtime identity reads。
- Ownership 後再驗證來源，變動時不建立 output 且釋放 lease。
- Update metadata 與 frozen Symbols 損壞被拒絕。

CLI 測試另驗證 help、必要參數、未知 options，以及 dry-run／formal 缺失來源錯誤。
測試使用真實暫存檔案、共用 lifecycle、lineage 和 resume；TradingView execution 邊界使用
注入的 fake driver。這些結果不代表真實 Desktop E2E 驗證。

Review finding、重現與修正見 [REVIEW.md](./REVIEW.md)。Lineage 測試另外驗證 depth 64
來源可供 Update 使用，同時維持 Extend 的新增深度限制。

## Not executed

- 真實 TradingView Desktop Update／interrupt／Resume 測試。
- 跨 Node 版本 matrix、package/release gate、發佈或 remote push。

Live 驗證流程已補到 [manual test](../../docs/strategy_automation_run_manual_test.md)。
