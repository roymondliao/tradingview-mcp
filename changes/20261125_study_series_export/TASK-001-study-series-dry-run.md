# TASK-001 · 預覽指標資料與匯出格式

狀態為已完成。此 task 擴充 [Pane 指標資料匯出](./README.md)。

## 使用情境

呼叫端以 `tv study series <entity_id> --dry-run` 查看目前 Pane 的指標內容。預覽須足以決定匯出完整 JSON，或選取其中一張表匯出 CSV。

## 行為與驗收

- 預覽與匯出共用實例定位、快照、日期篩選與選表流程。stdout 提供 JSON，以每張表的列意義、時間依據、欄位與 CSV 表頭、筆數、實際時間範圍和已知缺漏描述結果。
- 依選取後的表數給建議。多張表建議 JSON；單一表建議 CSV，也可選 JSON 以保留 metadata。明列理由，區分建議格式與正式匯出的預設格式。
- `--dataset boxes --format csv --dry-run` 可省略輸出路徑。多表 CSV、未知 dataset 與不合日期的快照沿用既有錯誤。若提供 output 路徑則檢查格式與副檔名。
- 預覽僅讀已載入的指標快照，沿用既有 Pane 選取行為。即使指定 `--output` 與 `--force`，預覽也不呼叫 writer。stdout 省略資料列；輸出檔案的存在性、權限與競寫檢查仍由正式寫檔處理。
- 驗證 OI／VFI 的 plots 表頭、Volume Profile 的多表與單表建議、日期區間、空表、partial issues，以及指定輸出路徑時的檔案行為。

## 驗證紀錄

在 `stg` 的 TXF1! 日線實測，Open Interest 選取 plots 時建議 CSV。VFI 使用台北時間 2012-12-01 至 2026-11-24 共 3,401 列，表頭含 `EMA of VFI [plot_2]` 和 `VFI [plot_3]`。Volume Profile 的圖表時間為 `2026-11-25T07:00:00Z`，完整快照含 48 個框、1 條線和 1 個標籤，建議 JSON；選取 boxes 並指定 CSV 時成功回報 48 列。

CLI 整合測試以相同選取條件核對預覽與正式 CSV 表頭，覆蓋空表、區間、缺漏與錯誤，並檢查既有檔案內容及尚未建立的輸出目錄。完整本機測試 897 項通過。
