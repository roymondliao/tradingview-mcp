# History To Delivery Evidence

## TASK 001 implementation

Date: 2026-11-03。Branch: `codex/history-to`。Runtime: Node `v26.12.1`。

- Core 增加共用日期解析與 `normalizeHistoryRange()`，在圖表讀取前驗證。
- CLI 註冊 `--to`，由 `runHistoryCommand()` 在 Pane context 準備前驗證並傳遞參數。
- 區間內累積、去重及筆數判斷共用範圍條件，來源分頁進度不受輸出篩選影響。
- 回傳新增 requested-to metadata，實際 period 與檔案內容使用同一份結果。

## TASK 001 automated checks

| Command | Result |
| --- | --- |
| `node --test tests/data/unit/history.test.js tests/cli/integration/router.test.js` | PASS，57 tests、0 failures；含 17 個 history 測試。 |
| `npm run lint` | PASS，0 errors、3 個既有 unused-variable warnings。 |
| `git diff --check` | PASS。 |

Lint warnings 位於 `src/core/data.js` 的兩個既有 catch variables，以及
`src/tools/watchlist.js` 的一個既有參數；本次未修改這些程式段落。

## TASK 001 covered behavior

- ISO 純日期 UTC 零時、明確時區、Unix 秒／毫秒與 Unix zero 的共同解析。
- 缺少／空白 `from`、空 `to`、不可解析日期及反向區間在 runtime 或 context 操作前失敗。
- CLI subprocess 在不可用 CDP port 下仍先回報日期參數錯誤。
- 多批資料晚於 `to` 時繼續載入；區間內去重、相等端點與超量裁切。
- N 等於上限且已涵蓋 `from` 為完整；N 超量時依原順序標示未完整。
- 實際末筆早於指定 `to`、有無上界時不同的空集合錯誤訊息。
- 無 `to` 的原有讀取、request limit、無進展、切換／還原與防覆寫測試維持通過。
- CLI raw options 傳遞與數字轉換、還原後寫檔，以及檔案／summary 的區間與筆數一致。

## TASK 002 verification

先以 commit `18c0a82` 提交 TASK-001 與本 change 的設計／需求文件，再執行 TASK-002。
原有三個策略檔案的未提交修改未納入該 commit，內容保持原樣。

| Command | Result |
| --- | --- |
| `node --test tests/data/unit/history.test.js tests/cli/integration/router.test.js` | PASS，67 tests、0 failures；含 27 個 history 測試。 |
| `npm run lint` | PASS，0 errors、同樣 3 個既有 warnings。 |
| `git diff --check` | PASS。 |

TASK-002 新增 10 個 history 測試，並擴充既有參數驗證案例，補齊：

- 實際讀取時的純日期 UTC 零時邊界，不包含截止日較晚的盤中 bar。
- 來源在抵達起點前耗盡，實際 period 與 requested range 分開呈現。
- 尚未匹配資料與已取得部分資料時，皆遵守 request limit。
- 剛好達到筆數上限但尚未涵蓋起點時，回傳 `max_bars` 與未完整結果。
- 後續 snapshot 缺失／缺少 first time、來源 stalled、初始來源讀取失敗。
- 初始讀取、request 與 poll 的 runtime exception 會傳遞，還原圖表且不寫檔。
- `--no-restore` 在成功及失敗時皆保留使用者指定的 symbol/timeframe。
- 真實暫存檔案的 bounded JSON、stdout metadata、一致的 requested／actual period、
  `EEXIST` 防覆寫與明確 `--force` 替換；測試結束清理自建目錄。
- CLI subprocess 的空字串／純空白 `from` 及空 `to` 在 CDP discovery 前失敗。

Repo `README.md` 已新增起訖範例及僅 `from` 的範例，說明必填依賴、日期零時、
明確時區、實際範圍、假日、輸出方式、停止原因及安全上限。

## Delivery status

TASK-001 與 TASK-002 皆完成，分別提交為 `18c0a82` 與 `83aac77`。
MCP schema 保持原樣，新增 core 回傳欄位為 additive metadata。
Desktop live 驗證 11 項檢查通過，詳見 [Live verification](./LIVE_VERIFICATION.md)。
目前圖表的 symbol、日線週期、chart type 及 study identities／visibility 已確認還原。
功能、測試與 live 紀錄已推送；v1.7.0 release 準備經以下檢查，待 PR 合併後由 workflow 發佈。

## Version 1 7 0 release checks

Package 與 lockfile 已同步為 `1.7.0`。版本確認時初次 audit 發現 body-parser 與 Zod
的兩項 high-severity 問題，已透過相容的 lockfile 更新排除，直接 dependency ranges 不變：
body-parser 2.4.0、iconv-lite 0.7.3、Zod 4.6.7；既有 ESLint 工具鏈保持原樣。

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts --cache /private/tmp/tv-history-release-npm-cache` | PASS，依最終 lockfile 安裝。 |
| `npm test` | PASS，835 tests、0 failures、0 skipped，包含上述最終 dependencies。 |
| `npm run lint` | PASS，0 errors、3 個既有 warnings。 |
| `npm run release:check-version` | PASS，package 與 lockfile 的版本皆為 1.7.0。 |
| `npm run --silent release:print-tag` / `node src/cli/index.js --version` | `v1.7.0` / `1.7.0`；MCP server 共用相同 VERSION。 |
| `npm pack --dry-run --json --cache /private/tmp/tv-history-release-npm-cache` | PASS，362 files、版本 1.7.0；包含 release notes，不包含 temp live artifacts。 |
| `npm audit --audit-level=high --cache /private/tmp/tv-history-release-npm-cache` | PASS，0 high／critical；保留 5 項 moderate 的 ESLint／minimatch 工具鏈問題。 |
| `git diff --check` | PASS。 |

完整測試在 lockfile 更新後重新執行。Desktop 的 11 項實測對應 `83aac77`，
該次 live 執行未包含後續的版本／dependency 更新；實測範圍以 [Live verification](./LIVE_VERIFICATION.md) 為準。
