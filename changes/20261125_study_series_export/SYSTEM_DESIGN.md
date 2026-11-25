# Pane 指標資料匯出 · System design

狀態為提案。使用情境與 CLI 範例見 [Feature request](./README.md)。

## CLI 與實例定位

沿用 `tv study list` → `tv study series <entity_id>`。使用者選的是某個 Pane 裡實際執行的 Study Instance，同名指標可以有不同參數或結果。CLI 在 `src/cli/commands/study.js` 註冊子命令，沿用 `PANE_CONTEXT_OPTIONS` 與 `withPaneContext` 的 Tab、Layout、Pane 選取規則。相關定義見 [Study 與 Strategy CLI 設計](../../docs/study_strategy_cli_design.md)。

| 選項 | 提議行為 |
| --- | --- |
| `--dataset <key>` | 預設取得該指標所有可讀資料集。可從 JSON 的資料集清單選擇單一類別，例如 `plots`、`boxes`。 |
| `--format json\|csv` | 預設 JSON，可攜帶多個不同結構的資料集。CSV 每次輸出一張表，若有多個資料集，提示可選的 key。 |
| `--output <path>`、`--force` | 預設將 JSON 寫到 stdout。指定檔案時，stdout 回傳含來源、欄位對照、筆數與實際時間範圍的 JSON 摘要。CSV 搭配 `--output`，符合現有 CLI 的 JSON stdout 約定。沿用現有檔案防覆寫與原子寫入機制。 |

## 從 Pane 到輸出檔案

1. **CLI** 先驗證參數，再解析 Pane。**Study core** 以同一圖表的 entity ID 綁定 Study 與 data source，取得 layout、pane、symbol、resolution 及實例名稱。找不到或目標在讀取中改變時回報錯誤。
2. **Desktop 資料讀取** 在同一次快照中檢查該 source 的 plot 定義、原始 rows、graphics 集合及其他可讀輸出。以 runtime 提供的資料結構選擇讀取方式，指標名稱僅供顯示。現有 graphics 程式可供重用；其按名稱篩選的入口需要改成從已綁定的 source 讀取，才能隔離同名實例。[Study core](../../src/core/studies.js) · [既有圖形讀取](../../src/core/data.js)
3. **正規化** 將各類輸出整理為具欄位定義的資料集。保存輸出的來源種類、欄位 ID、顯示名稱及座標單位。數值和圖形可同時出現在同一實例。遇到新的 runtime 類型時，在讀取層擴充該類型，CLI 介面繼續使用 entity ID。
4. **序列化** 以同一份結果產生 JSON 或 CSV，再從結果計算摘要。沿用 repo 的 Unix 秒轉 ISO UTC 工具與單一檔案寫入機制。[時間轉換](../../src/core/time.js) · [檔案輸出](../../src/core/artifacts.js)

## 資料與時間契約

JSON 根物件包含 `context`、`study`（含 entity ID 與可讀 inputs）、`captured_at_iso`、`scope: "loaded"`、`status`、`datasets` 及 `issues`。每個 dataset 有 `key`、`columns`、`rows`、`row_count`，能解析資料時間時另附實際範圍。CSV 的 plot 表頭使用「顯示名稱 [穩定 key]」，缺少名稱時以目標及欄位角色標示。其餘欄位使用 key。

| 資料集 | 一列的意義 | datetime 與數值語意 |
| --- | --- | --- |
| `plots` | 一個指標資料點，包含該筆所有數值 plot | 讀取指標 row 自帶的 `time`（Unix 秒），產生 `time_iso`（UTC），依時間升序。按 metadata 的 plot ID 與原始 slot 讀值，顯示名稱可重複。保留 0，缺值為 JSON null／CSV 空欄。顏色索引等樣式欄位另以其角色標明。 |
| `boxes`、`lines`、`labels` 等圖形 | 一個有身分類別及物件 ID 的圖形 | 保留原始 x/y 錨點、價格、文字及可用的樣式。單點可附 `time`，區間可附 `start_time`、`end_time` 與各自的 ISO 欄位。Bar index 須透過該來源的索引映射及同一圖表時間軸解析。未確認座標單位或錨點落在時間軸外時，保留原座標，時間填 null 並說明原因。 |
| 表格或其他目前狀態 | 一個儲存格或一項具名值 | 保留 table ID、列欄位置、文字或可讀原值。沒有 bar 錨點時只提供擷取時間。僅能讀到 Data Window 顯示文字時，標記為格式化快照。 |

與 OHLCV 併表時以相同 symbol、resolution 及 bar timestamp 對齊。跳過的時段保留缺口。若來源在同一 timestamp 有多筆，保留來源順序與識別資訊，避免覆寫。圖形的時間錨點描述其繪製位置；僅憑目前快照無法重建先前各根 K 棒上的圖形狀態。

對固定範圍成交量分布而言，box 的上下界是可匯出的價格座標。只有來源明確提供價位區間與成交量欄位時，才額外輸出具名的價量分布資料集。矩形寬度、顏色及標籤按其原始含義保存，以免把畫面比例誤當成交口數。

## 結果完整性

* 已辨認的輸出均讀取成功時回報 `ok`，完整性限於擷取當下已載入的資料。可讀集合確實為空時記錄零筆。
* 已取得部分資料、仍有未支援的輸出種類或無法解析的錨點時回報 `partial`。每筆 issue 指出資料集、欄位或物件及原因。只有快照文字可讀時，明列其可用範圍。
* 找不到指定實例、來源尚未就緒或完全無法取得資料時，回報具體錯誤並保留原有輸出檔。明確選擇不存在的 dataset 時列出可用項目。這些狀態應與已確認的空集合分開。

## Desktop 觀察與驗收方法

2026-11-25 在 `stg`、Pane 0、`TAIFEX_DLY:TXF1!`、`1D` 做唯讀抽查。下列資料是設計依據。正式驗收應將匯出與同次 Desktop 來源比對，數值、筆數及 entity ID 都可能隨圖表更新。

| 測試實例 | 已觀察到的輸出 | 實作時的對照 |
| --- | --- | --- |
| Open interest | `time=1795590000` 時 OI 原值為 `131341`，資料視窗顯示 `131.34 K`。 | 選中同一時間的指標 row 核對精度，再與同一根日 K 的時間比對。 |
| Volume Flow Indicator | `plot_0` 和 `plot_1` 標題都是 `Plot`，其餘為 `EMA of VFI`、`VFI`。樣本前兩值為 `0` 和 `null`。 | 以四個 plot ID 比對 JSON 與 CSV 欄位、精度及缺值。 |
| Volume Profile / Fixed Range (150, 24, 70, 2) | 此實例的 plot 定義為空；快照含 48 個 box、1 條 line、1 個 label。 | 對照當次物件 ID、數量、價格邊界及標籤文字。抽樣比對可解析的錨點日期，涵蓋無法解析的座標；空 plots 仍須交付圖形資料。 |

自動化測試另涵蓋跨 Pane 同名實例、plot 與 graphics 混合、純表格、未知圖形類型、空集合、缺少 bar、重複標題、CSV 跳脫，以及輸出失敗時既有檔案的完整性。實測的三個指標是驗收樣本，支援範圍由資料類型決定。
