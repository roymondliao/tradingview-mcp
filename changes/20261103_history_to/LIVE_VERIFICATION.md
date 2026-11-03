# History To Desktop Live Verification

Date: 2026-11-03。Result: **PASS，11 項檢查通過**。

## Environment and scope

- 驗證 commit：`83aac77ed3a1bf57e182d12068605cbad8a62f2a`，branch `codex/history-to`。
- 透過 repo CLI 連線至已開啟的 TradingView Desktop，使用目前作用中的 `stg` 圖表。
- Chart URL ID：`HQJPvW0n`；Pane index：`0`；Pane ID：`1`。
- 原始 symbol：`TAIFEX_DLY:TXF1!`；resolution：`1D`；chart type：`1`。
- 先讀取 chart state 及最近 100 筆 OHLCV，作為日期及價格／成交量的比較來源。
- 歷史載入上限設為 `max_requests=3`、`max_bars=100`，筆數裁切案例另設 `max_bars=3`。

## Live checks

表內時間皆為 UTC，結果由實際 CLI stdout／輸出檔案及原始 OHLCV 比對得出。

| Check | Requested range or action | Observed result |
| --- | --- | --- |
| 指定起訖及檔案輸出 | `2026-10-01T00:00:00Z` 至 `2026-10-31T23:59:59Z` | 19 筆；實際 `10-01 07:00` 至 `10-30 07:00`；`from_reached`、完整。所有時間戳及 OHLCV 值符合來源。 |
| Metadata 一致性 | 同區間，不指定 include-bars | 筆數、period、requested-to 欄位與輸出檔案一致；stdout 無 bars。 |
| 純日期上界 | 起點不變，`--to 2026-10-30` | 18 筆；requested-to 為 `10-30 00:00`，實際末筆為 `10-29 07:00`。 |
| 週日上界 | 起點不變，`--to 2026-11-01T23:59:59Z` | 19 筆；末筆為週五 `10-30 07:00`，與 10 月區間結果相同。 |
| 只有 from | `--from 2026-10-01T00:00:00Z` | 20 筆；末筆為來源最新可用的 `11-02 07:00`；兩個 requested-to 欄位為 null。 |
| Unix 秒／毫秒 | `--from 1790812800 --to 1793491199000` | 與 ISO 起訖區間的 19 筆資料完全一致。 |
| 相等端點 | `--from 1793343600 --to 1793343600` | 精確回傳 `10-30 07:00` 的 1 筆 bar。 |
| 區間內筆數上限 | 10 月區間，`--max-bars 3` | 保留 `10-28`、`10-29`、`10-30` 三筆；`max_bars`、`complete=false`。 |
| 必要參數先驗證 | 單獨 `--to` 並給不存在的 Chart selector | Exit 1，錯誤為 `--to requires --from`，未進入 context 查找。 |
| 暫時切換週線 | 10 月區間，`--timeframe 1W` | 回傳 5 筆週線，實際 `10-02 07:00` 至 `10-30 07:00`；全部位於指定區間。 |
| 還原檢查 | 週線讀取結束後重新讀 chart state | Symbol、resolution `1D`、chart type 及 study IDs／types／visibility 與原始值相同。 |

## Commands

下列為主要案例的實際命令形態，均由 Node 執行 repo 內的 CLI entrypoint：

```bash
node src/cli/index.js history --url-chart-id HQJPvW0n --pane-index 0 \
  --max-requests 3 --max-bars 100 \
  --from 2026-10-01T00:00:00Z --to 2026-10-31T23:59:59Z \
  --include-bars --output temp/history-to-live-20261103-6r1lhaom/bounded.json

node src/cli/index.js history --url-chart-id HQJPvW0n --pane-index 0 \
  --max-requests 3 --max-bars 100 \
  --from 2026-10-01T00:00:00Z --to 2026-11-01T23:59:59Z \
  --include-bars --output temp/history-to-live-20261103-6r1lhaom/weekend.json

node src/cli/index.js history --url-chart-id HQJPvW0n --pane-index 0 \
  --max-requests 3 --max-bars 100 --from 2026-10-01T00:00:00Z \
  --include-bars --output temp/history-to-live-20261103-6r1lhaom/from-only.json

node src/cli/index.js history --url-chart-id HQJPvW0n --pane-index 0 \
  --max-requests 3 --max-bars 100 --timeframe 1W \
  --from 2026-10-01T00:00:00Z --to 2026-10-31T23:59:59Z \
  --include-bars --output temp/history-to-live-20261103-6r1lhaom/weekly-restore.json
```

輸出檔案預設防覆寫，重跑時應改用新目的地，或明確指定 `--force`。

## Artifacts and coverage limits

本機原始結果保存在
[verification.json](../../temp/history-to-live-20261103-6r1lhaom/verification.json)，
相同目錄包含各案例的 JSON、stdout／stderr 及前後 chart state。
執行腳本為 [verify-history-to-live-20261103.py](../../temp/verify-history-to-live-20261103.py)。
`temp/` 受既有 gitignore 排除，不納入提交；本文件保存可追溯的實測結果。

本次指定區間已存在於圖表載入資料，所有成功 history 案例的 `requests_made` 皆為 `0`。
真實向過去載入的 CDP requests 及讀取失敗／無進展等情境仍由 mocked runtime 測試覆蓋，
本次 live 結果不宣稱驗證這些外部失敗情境。
未使用 live `--no-restore`，以保留使用者圖表狀態；此選項的成功／失敗路徑已有單元測試。
