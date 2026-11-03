---
id: FEATURE-20261103-HISTORY-TO
title: History To Date
status: done
created: 2026-11-03
scope:
  - history-cli-to-option
  - history-core-date-range
  - history-tests-documentation
---

# History To Date

Status: `done`，CLI／core 實作、本機自動化驗證、使用文件與 Desktop live 驗證已完成。
Live 檢查範圍與限制見 [Live verification](./LIVE_VERIFICATION.md)。

Feature branch：`codex/history-to`，由 `fork-main` 的
`1b32b83` 建立。

## Feature request

為 `tv history` 新增選用參數 `--to`，讓使用者能指定歷史 OHLCV 的截止日期，
使用時必須搭配既有 `--from`，匯出指定期間的行情。
僅設定 `--from` 時，沿用原本設計：從指定起始時間取得至圖表當前可用的最新行情。

目前 `src/cli/commands/data.js` 僅註冊 `--from`，底層
`src/core/data.js` 的 `getHistory()` 也只處理起始時間。
目前結果會包含起始時間至最新已載入 bar 的資料，無法直接指定截止時間。

## CLI examples

以下為預期支援的用法：

```bash
# 指定起訖時間，包含兩個端點
tv history --symbol NASDAQ:AAPL -t D \
  --from 2026-01-01T00:00:00Z --to 2026-06-30T23:59:59Z \
  --include-bars --output history.json

# 只指定起始時間時，取得至圖表當前可用的最新行情
tv history --symbol NASDAQ:AAPL -t D --from 2026-01-01T00:00:00Z --include-bars

# Unix timestamp 與既有 --from 使用相同格式及單位判斷
tv history --from 1767225600 --to 1782863999 --include-bars
```

## Proposed date and output contract

下列為本需求的初始規格，實作與驗收依此進行。

- `--to` 為選用參數，但必須搭配有效的 `--from`。
  只傳 `--to`，或 `--from` 為空值時，應報錯並提示 `--to requires --from`。
  不提供 `--to` 時，保留僅傳 `--from` 或兩者皆不傳的目前行為。
- 日期解析沿用 `--from`：接受 ISO 日期／時間、Unix 秒，以及既有規則可辨識的
  Unix 毫秒；內部統一為 Unix 秒。錯誤訊息應指出無效的是 `from` 或 `to`。
- 依 bar 的 `time` 篩選：同傳 `from` 與 `to` 時，範圍為 `from <= time <= to`；
  僅傳 `from` 時，取得指定起始時間至圖表當前可用的最新 bars，
  沿用既有僅篩選 `time >= from` 的邏輯，不額外以系統當前時間設定截止點。
  兩者皆不傳時，沿用目前取得全部可用歷史資料的行為。
  此時間是 bar 本身的時間戳，不將跨越截止時間的 bar 拆分。
  實際最後一筆 bar 受交易時段、資料更新及來源可用性影響，可能早於截止點。
- 純日期如 `--to 2026-06-30` 與既有解析規則一致，代表該日 UTC 00:00:00，
  不自動擴展至當日結束。需要包含整日的使用者可傳入明確的日末時間與時區。
- 缺少必要的 `from`、無效日期或 `from > to` 應在讀取或切換圖表前失敗；
  `from == to` 合法。此驗證同樣適用共用 `getHistory()`。
- 新增回傳欄位 `requested_to` 與 `requested_to_iso`，分別記錄正規化後的
  Unix 秒與 ISO 時間；未明確指定 `--to` 時為 `null`，表示使用者未指定截止點，
  此時結果延伸至圖表當前可用的最新 bar。`period.to` 記錄實際最後一筆 bar 的時間。
- `period`、`bar_count` 與選用的 `bars` 均反映篩選及 `max_bars` 裁切後的結果。
  Metadata 預設輸出、`--include-bars`、`--output` 與 `--force` 使用相同結果。
- 無符合區間的 bar 時，維持目前無符合資料即報錯的行為，訊息改為適用起訖區間。

## History loading and limits

`--to` 是輸出資料的上界，不改變向過去載入歷史的方向。
已載入資料全部晚於 `to` 時，應繼續往前載入，直到涵蓋所需範圍、
資料來源耗盡，或觸及既有安全上限。

`max_bars` 只計算符合起訖區間的 bars；晚於 `to` 的近期 bars
不能提前耗盡回傳筆數上限。需要裁切時，保留區間內最新的 `max_bars` 筆，
並維持時間由舊到新的順序及去重行為。

保留既有 `max_requests`、`bars_per_request`、停止原因及 `complete` 語意。
到達 `from` 或資料來源耗盡可標記完整；因筆數、請求次數、讀取失敗或無進展
而停止時，應如實反映未完整。僅到達 `to` 不代表已涵蓋指定的起訖區間。

## Scope

本需求涵蓋 CLI option 與 help、共用 `getHistory()` 的日期驗證、區間篩選、
分頁筆數計算、回傳 metadata、檔案輸出驗證，以及使用說明。
沿用圖表鎖、symbol/timeframe 切換、還原與 TradingView 可用歷史限制。

不新增 MCP `data_get_history` 的 `to` schema；既有未傳 `to` 的 MCP 呼叫保持相容。
不包含其他命令的日期參數、時區設定、補齊缺失行情或突破資料來源限制。

## Acceptance criteria

- [x] `tv history --help` 顯示 `--to` 的用途、可接受格式及必須搭配 `--from`。
- [x] 支援同傳 `--from --to`、僅傳 `--from`，以及兩者皆不傳。
- [x] 僅傳 `--from` 時取得起始時間至圖表當前可用的最新行情，維持原有篩選邏輯。
- [x] 單獨傳入 `--to` 或搭配空值 `--from`，在圖表操作前報錯並提示必要參數。
- [x] ISO、帶時區時間、Unix 秒／毫秒與純日期遵循上述規則。
- [x] 邊界相等時包含該 bar；無效日期及反向區間在圖表操作前拒絕。
- [x] 較新的區間外 bars 不阻擋向過去載入，亦不占用 `max_bars`。
- [x] Metadata、bars 與輸出檔案的範圍、筆數一致，且新增 requested-to 欄位。
- [x] 無符合資料、資料耗盡及各種安全上限情境有明確結果。
- [x] 未指定 `--to` 的既有行為、圖表還原及檔案覆寫規則通過回歸驗證。
- [x] 相關單元測試、CLI 測試、lint 與 diff whitespace 檢查通過。

## Tasks

| Task | Status | Depends on |
| --- | --- | --- |
| [TASK-001: CLI and core date range](./TASK-001-cli-core-date-range.md) | `done` | 本需求規格 |
| [TASK-002: Tests and documentation](./TASK-002-tests-documentation.md) | `done` | TASK-001 |

## Design references

- [System design](./SYSTEM_DESIGN.md)：元件責任、資料流程、日期語意與相容性。
- [Low level design](./LLD.md)：函式介面、驗證邊界、分頁演算法、輸出與測試設計。
- [Delivery evidence](./DELIVERY_EVIDENCE.md)：兩項 task 的實作及本機檢查結果。
- [Live verification](./LIVE_VERIFICATION.md)：Desktop 的 11 項實測結果與圖表還原證據。
- [Release notes](./RELEASE_NOTES.md)：v1.7.0 的功能、修正與相容性說明。
