---
id: TASK-002
title: History To Tests and Documentation
status: done
phase: history-to
depends_on:
  - TASK-001
blocks: []
scope: history-verification-documentation
---

# TASK-002 History To Tests and Documentation

## Goal

驗證日期上界、歷史分頁與輸出結果，並提供可直接使用的 CLI 範例。

TASK-001 已加入日期驗證、主要分頁與筆數邊界、CLI 接線及還原後寫檔的必要回歸測試，
並通過本機檢查，見 [驗證紀錄](./DELIVERY_EVIDENCE.md)。
本任務已補齊指定 `to` 時的讀取失敗、無進展、request limit、runtime exception、
no-restore 與實際檔案寫入案例，並完成使用文件。

## Test coverage

依 [System design](./SYSTEM_DESIGN.md) 與 [LLD verification plan](./LLD.md#verification-plan)
驗證實際行為，不以真實市場日期、Desktop 或系統時鐘作為必要前提。

### Core and output tests

擴充 `tests/data/unit/history.test.js`，以現有 `_deps` 模擬 history runtime：

- 必要參數：僅 `to`、空字串／純空白 `from` 應報錯；Unix `0` 不視為缺少。
- 解析與區間：純日期 UTC 零時、ISO offset、Unix 秒／毫秒、空 `to`、不可解析日期、
  反向區間、相等端點及無符合資料。驗證錯誤前不讀取或切換圖表。
- 分頁：初始整批與中間多批皆晚於 `to`，來源仍向過去移動時應繼續載入，
  直到跨越 `from`、資料耗盡或觸及既有安全上限。
- 筆數與排序：區間外 bars 不占用 `max_bars`、時間戳去重、超量保留最新 N 筆並升序輸出。
- 停止優先序：N 等於上限且涵蓋 `from` 為 `from_reached`；N 超量即使涵蓋
  `from` 仍為 `max_bars`，並驗證 `complete` 差異。
- 停止與失敗：`no_more_data`、`max_requests`、`max_bars`、`read_failed`、
  `no_progress` 及 runtime exception；來源有進展但篩選集合為空不得誤判。
- 假日與相容性：末筆 bar 可早於 `to`；僅傳 `from` 及兩者皆省略維持原有結果，
  不加入系統時間截止條件，無 `to` 時保留原有空集合錯誤訊息。
- 回傳與輸出：requested-to 欄位、`period`、`bar_count`、metadata-only、
  `include_bars`、檔案內容與 stdout summary 一致；未傳 `to` 時新增欄位為 null。
- 還原與寫檔：成功及失敗沿用 symbol/timeframe 還原，保留 `--no-restore`、
  預設防覆寫及 `--force`，不在 core 完成前輸出檔案。

### CLI tests

在 `tests/data/unit/history.test.js` 直接測試 TASK-001 的 `runHistoryCommand()`：

- 注入 validator、context、core 及 output 函式替身，驗證 raw `from`／`to` 傳遞。
- Validator 失敗時不準備 Pane context、不讀取 core、不寫入檔案。
- 成功時先 preflight、再 context 與 core，最後才處理選用的檔案輸出。
- 沿用普通函式注入，不需要 experimental module mock。

擴充 `tests/cli/integration/router.test.js` 的 subprocess 測試：

- Help 顯示 `--to` 的格式與 `requires --from`。
- 缺少 `from`、無效日期與反向區間提供對應參數錯誤。
- 使用不可用 CDP port，確認這些錯誤出現在 discovery 前，未被 CDP 連線錯誤取代。

## Documentation and checks

- [x] 更新 repo `README.md`，加入 `--from --to` 及僅 `--from` 的範例。
- [x] 說明 `to` 必須搭配 `from`、純日期為 UTC 零時，以及包含整日須傳明確日末時間與時區。
- [x] 說明 requested range 與實際 `period` 的差異、假日結果及既有安全上限。
- [x] 通過 core、CLI helper 與 CLI subprocess 的上述案例及既有回歸測試。
- [x] 執行以下檢查，將實際結果記錄於本 change 的 `DELIVERY_EVIDENCE.md`。
- [x] 完成後更新需求與 task 狀態，僅勾選有驗證證據的驗收項目。

```bash
node --test tests/data/unit/history.test.js tests/cli/integration/router.test.js
npm run lint
git diff --check
```

驗證結果：67 tests 通過、0 failures，含 27 個 history 測試；lint 為 0 errors、
3 個既有 warnings；diff whitespace 檢查通過。詳細案例見 [驗證紀錄](./DELIVERY_EVIDENCE.md)。
未執行 Desktop live 驗證。
