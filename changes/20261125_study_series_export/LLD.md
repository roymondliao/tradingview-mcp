# Pane 指標資料匯出 · Low-level design

狀態為設計提案。基準為 `fork-main@a167ae5`，分支為 `codex/study-series-export`。功能範圍與實測背景見 [Feature request](./README.md)、[System design](./SYSTEM_DESIGN.md)。

## 1. CLI 與呼叫順序

```text
tv study series <entity_id> [pane selectors] [--dataset <key>]
                            [--format json|csv] [--output <file>] [--force]
```

在 `study` 的 subcommands map 註冊 `series`，繼承 Desktop dependency。以字串接收一個非空 entity ID；選格沿用 `PANE_CONTEXT_OPTIONS`。預設 format 為 JSON，副檔名不會改變格式；已知的 .json／.csv 與 format 衝突時直接提示正確旗標。CSV 須提供 output，force 須搭配 output。router 的 `parseArgs` 使用 `strict: false`，因此由此 handler 檢查未知旗標、空參數及額外 positional，避免拼錯 selector 而讀到目前 Pane。上述檢查在 attach 或 focus 前完成。[CLI 註冊](../../src/cli/commands/study.js) · [Router](../../src/cli/router.js)

```js
const request = parseStudySeriesOptions(opts, positionals)
const snapshot = await withPaneContext(opts, context =>
  getStudySeries({ entity_id: request.entity_id, context }))
const result = selectDatasets(snapshot, request)
return request.output ? writeStudySeriesArtifact(result, request) : result
```

`withPaneContext` 在 callback 結束後才將 context 加入回傳物件，因此應在 wrapper **外面**選表、寫檔與建摘要，讓檔案也帶有同一份 context。已提供 `--dataset` 時，JSON 仍使用相同 envelope，只保留該資料集；CSV 只取該表。省略 dataset 時，JSON 包含全部；CSV 僅在恰有一個可讀資料集時自動選取（含已確認的零列表），多表時列出可選 key。檔案和 stdout 摘要都沿用同次擷取結果。[Pane wrapper](../../src/cli/pane-context.js)

## 2. 模組界面與快照所有權

| 位置 | 提議介面及責任 |
| --- | --- |
| `src/cli/commands/study.js` | 新增註冊與 handler，解析上述選項、注入 core 與檔案 writer。 |
| `src/core/study-series.js`（新增） | `getStudySeries({entity_id, context, _deps})` 驗證身分、呼叫 page reader、將原始資料正規化；`selectDatasets(snapshot, request)` 為純函式。由 `studies.js` re-export 入口，使既有 `core.studies` namespace 可用。 |
| `src/core/study-series-runtime.js`（新增） | `readStudySeriesPage(expected, entityId)` 為自包含、同步的 page function。輸出 plain data 或帶 code 的失敗資料；傳入值經 `callPageFunction` 的 CDP arguments 傳遞。 |
| `src/core/study-series-format.js`（新增） | `writeStudySeriesArtifact(result, {format, output, force})` 寫單一檔，回傳與檔案一致的摘要。JSON 使用 `writeJsonArtifact`，CSV 使用 `createArtifactTransaction`。 |

**一次定位、一次擷取。** `prepareContext` 已取得 target、layout、pane、symbol 與 resolution。core 用 `activatePaneContext({context, activate:false, reacquire:false})` 在讀取前後核對 target/layout/pane 所有權，另比對回傳的 symbol、resolution。page reader 以 `_chartWidgetCollection.getAll()[pane_index]` 綁定 widget，核對 active wrapper 的 `_chartWidget`、商品與週期，在這個 model 的 `dataSources()` 以 entity ID 唯一匹配。用 wrapper 的 `getStudyById(entityId)` 取得同一實例的 inputs；身分矛盾時丟棄整份結果。在同步 page call 內完成 metadata、plot、graphics、時間軸和 inputs 投影，以免兩次查詢跨到不同的 bar 更新。前後檢查只讀身分。沿用 prepareContext 既有的選格行為；資料讀取不觸發載入歷史、切換商品或變更指標可見性。[Pane 身分檢查](../../src/core/pane.js) · [CDP 呼叫](../../src/connection.js)

**共用邊界。** `getActivePaneStudy` 目前先取 state 再查 inputs；`getPineBoxes`、`getPineLines` 等目前按名稱找遍 sources，再做四捨五入、去重或摘要。應抽出可傳入單一 source 的底層 collection traversal，保留舊 caller 的 filters、limits 與摘要。在 page reader 內組裝可序列化的純函式或內嵌 traversal；`callPageFunction` 只傳函式文字，不能引用 Node 模組閉包。inputs 沿用 `getActivePaneStudy` 的公開欄位投影及 `buildStudyInputCatalog({values, info})`。同一份 meta 可在 Node 端使用現有 study 分類函式；`source: unknown` 且實例已有可讀資料，仍能匯出。[Studies](../../src/core/studies.js) · [現有資料讀取](../../src/core/data.js)

## 3. 輸出資料契約

下列為提議的公開欄位。JSON 的 rows 使用以 column key 為鍵的物件，CSV 完全依 `columns` 順序輸出。欄位對照保留在 JSON 或 CSV 寫檔後的 stdout 摘要。

```text
Result   { schema_version: 1, success: true, status: "ok" | "partial",
           scope: "loaded", captured_at_iso, context, study,
           available_datasets: string[], datasets: Dataset[], issues: Issue[] }
Study    { entity_id, name, type, source, inputs }
Dataset  { key, columns: Column[], rows: Row[], row_count, period }
Column   { key, title, type, role, unit?, source_id?, source_slot? }
Period   null | { from, from_iso, to, to_iso }
Issue    { code, dataset?, field?, object_id?, message, count? }
```

`captured_at_iso` 來自 page 擷取時刻；`period` 僅以該表實際解析出的資料時間取 min/max（包含區間兩端）。`available_datasets` 是套用 selector 前成功辨認且可讀的表名。成功但部分缺漏仍保留 `issues` 與快照層級的 `status`，即使使用者只選其中一表。無法讀取被明確指定的表則報錯。每表的 `row_count` 等於輸出列數。

### Plot 與 datetime index

1. 讀取 `source.metaInfo().plots` 的原始排列與 `styles[plot.id]?.title`。先記錄每個 slot 的 ID、title、type、role，再投影值。JSON 使用 plot_0 等 key；CSV 將 title 與 key 一起列在表頭；同名 title 可並存。缺失、重複或與保留欄位衝突的 ID 採固定 slot 衍生 key 並檢查唯一性，保留原 ID 和 issue。顏色或 OHLC slot 依 metadata 標記角色；未知型別保留可表示的原值並註記。
2. 以 `source.data().each((logicalIndex, row) => …)` 迭代存在的列。本次 Desktop 的 `row[0]` 為 Unix 秒，metadata 中第 i 個 plot 對應 `row[i+1]`。按原始位置取值，即使中間有 colorer 或空 slot。合法空值投影為 null，零保留。缺 slot 或不符已知結構時附 issue。無 plot 定義的圖形實例繼續進入 graphics 探測。
3. 輸出 `time`、`time_iso`、`source_index` 及各 plot 欄，ISO 使用 `unixSecondsToIso`。依 time 升序，同時間維持來源順序並保留 source_index。該 index 僅供快照內追蹤。時間無法解析的來源列保留 index 與值，time 設 null、置於有時間列之後並附 issue。無交易或來源未產生 row 的日子保留缺口。

例如 VFI 的一列可寫成以下 CSV 投影（略去 source_index）；完整匯出另有 source_index 欄。同一指標的 `plot_0`、`plot_1` 都叫 Plot，第二個欄位的空字串在 CSV 代表缺值。

```csv
time,time_iso,Plot [plot_0],Plot [plot_1],EMA of VFI [plot_2],VFI [plot_3]
1795590000,2026-11-25T07:00:00.000Z,0,,-9.131243986108498,-9.933802030173386
```

### Graphics、表格與顯示值

以綁定 source 的 `_graphics._primitivesCollection` 和 metadata 辨識其中有資料或明確宣告的種類。共用容器可能預先配置其他空類別，不能據此讓每個指標都產生數十張空表。對已宣告／實際存在的 collection 保留可確認的空結果、精度及同座標的不同物件。以下對應是目前 repo 已有的讀取起點。

| Dataset key | Collection / key | 每列來源欄位與輸出 |
| --- | --- | --- |
| `boxes` | `dwgboxes / boxes` | map item ID、原始 x1/x2/y1/y2、框線、填色與文字樣式，附兩端時間。 |
| `lines` | `dwglines / lines` | ID、原始兩端座標、線型、顏色、延伸屬性，附兩端時間。 |
| `labels` | `dwglabels / labels` | ID、x、y、位置模式、文字、樣式，附錨點時間。 |
| `table_cells` | `dwgtablecells / tableCells` | 每格一列，保留 ID、tid、row、col、文字與樣式，保留空字串與零座標。 |
| `display_values` | 同 source 的 `dataWindowView().items()` | 逐項輸出 item ordinal、title、display_text。同名項目可並存，僅使用擷取時間。 |

在現行 Desktop，前三種 collection 路徑為 `outer.get(key).get(false)._primitivesDataById`；表格也可直接位於 `outer.get(key)._primitivesDataById`。按實際集合／group 遍歷，若兩條路徑指向同一個 Map，只讀一次。以 group 和物件 ID 保留身分；未知且有內容的 group 記錄 issue。有文件化意義的欄位才翻成具名數值；其他可讀樣式保存為 plain JSON 的 `attributes`。新類別由相同的 dataset 轉換介面擴充。只有來源直接提供 bin 邊界與成交量時才建立 `profile_bins`；box 寬度僅是圖形座標。若僅有格式化顯示值可讀，交付 display_values 並標記 `partial`。

### 圖形座標的時間解析

將 `resolveGraphicsAnchor(rawX, graphics, model)` 放在 page reader 內，使座標、指標映射與時間軸同屬一次讀取。對已驗證的 Pine graphics 索引型態，從 `graphics._indexes[rawX]` 取得 chart logical index，再呼叫 `model.timeScale().indexToTimePoint(index)`。保存原始 x、解析後 index、Unix 秒及 UTC ISO。單點欄位為 `time/time_iso`，兩端欄位為 `start_time/start_time_iso`、`end_time/end_time_iso`，各自對應 x1/x2。直接帶時間的其他來源依其已知單位明確轉換。來源型態未知、映射缺值、未來延伸點或回傳單位未確認時，保留可取得的座標、時間填 null，issue 指到具體端點。

2026-11-25 在 Desktop 3.5.0 的 `stg / TAIFEX_DLY:TXF1! / 1D`、Volume Profile / Fixed Range 實測同一個 box。最後一欄用 `mainSeries().bars().valueAt(index)[0]` 獨立核對，提供 fixture 與 live 驗證基準。

| 端點 | 原始 x | graphics._indexes[x] | indexToTimePoint | 同 index 日 K 時間（Unix 秒） |
| --- | ---: | ---: | ---: | ---: |
| x1 | 0 | 150 | 1776668400 | 1776668400 |
| x2 | 1 | 151 | 1776754800 | 1776754800 |

此讀取路徑已驗證於上述實例。其他圖形格式應先驗證座標語意。逐根 plot 已自帶時間；表格只有擷取時間。三者在 schema 中分開記錄。

## 4. 完整性、錯誤與發布

每個 reader 區分「不適用」、「已讀取（可為零列）」、「已宣告但不可讀」與「來源尚在載入」。先發現各輸出種類，再彙總；缺少單一私有欄位不能提前中止其他 reader。對未支援種類、座標缺口與局部讀取錯誤，issue 記錄 code 和位置；大量重複錯誤可依類別／欄位彙總次數並保留一個樣本 ID。資料量隨已載入資料列和繪圖物件數成長，只投影序列化所需欄位。遇傳輸錯誤或 CDP 逾時走既有錯誤路徑，不能靜默截短或發布前半份快照。

| 條件 | 結果及 CLI 行為 |
| --- | --- |
| 已辨認且讀取成功，含確認為空的表 | `success: true, status: ok`，exit 0。 |
| 至少有可交付資料集，另有無法讀取或解讀的輸出 | `success: true, status: partial`，exit 0，摘要保留 issues；呼叫端可檢查 status。 |
| pane 身分改變／指定實例消失 | 沿用 `PANE_CONTEXT_CHANGED` 或新增 `STUDY_INSTANCE_NOT_FOUND`（identity）；不寫檔。 |
| 只有載入中訊號／完全沒有可讀輸出 | 提議 `STUDY_SERIES_NOT_READY`（retryable）／`STUDY_SERIES_UNAVAILABLE`；均為 core 領域錯誤。 |
| dataset 不存在或不可讀／CSV 無法唯一選表 | 提議 `STUDY_DATASET_UNAVAILABLE`／`STUDY_DATASET_REQUIRED`，在訊息附可選 keys；exit 1。 |
| CDP 或檔案錯誤 | 透傳既有 code、kind、phase；依 router，CDP exit 2，其餘一般錯誤 exit 1。 |

page 端只回傳可序列化的失敗資訊；Node 端建立 `CoreOperationError`。domain 錯誤使用既有 kind 集合（例如 reader 狀態用 internal，參數用 validation），`phase` 區別 capture、selection 與 write。CLI 由 router 統一輸出 JSON diagnostics。[錯誤契約](../../src/core/errors.js)

JSON 檔使用 `writeJsonArtifact`。CSV 共用 strategy formatter 中的通用 cell/line 跳脫邏輯（目前是私有函式，實作時抽出共用部分）。欄位含逗號、雙引號、CR/LF 時用雙引號包裹並加倍內部引號，結構化 attributes 編成 JSON 再跳脫。CSV 以 UTF-8 寫 header 與每列，零列保留 header。流程為 `openArtifact() → 寫入並等待 stream finished → publish()`；寫入或發布失敗走 `abort()`，保留主錯誤。預設 hard link 避免同路徑競寫覆蓋，force 以 rename 替換。成功摘要保留 schema、身分、status、issues、各表 columns／row_count／period，省略 rows，附 output 的 path／format／bytes／atomic。[Artifact transaction](../../src/core/artifacts.js) · [CSV encoder 先例](../../src/core/strategy-trading-format.js)

## 5. 實作驗證

| 層級 | 案例與判定 |
| --- | --- |
| Study unit · page reader | 用最小 fake chart/source/map 跑實際的 page function。同名實例、相同 entity ID 在不同 Pane、讀取時換 symbol／resolution 或 target 均驗證。混合 plots + graphics 兩者都須出現。 |
| Study unit · plot／graphics | OI 含中間色碼 slot；VFI 四欄含重複 title、0、null；保留重複 timestamp 與來源順序。Volume Profile 測上述兩階段映射、單端缺值、同座標不同 ID、48 boxes + line + label 的固定 fixture。涵蓋表格兩種儲存路徑、文字快照及未知圖形。 |
| CLI / writer integration | help 和參數錯誤可離線驗證；注入 snapshot，對照 JSON 檔與 stdout 摘要，以及 CSV header、欄位、空值和跳脫。覆蓋未知 dataset、多表 CSV、零列表、partial、既有輸出、force、寫入失敗與兩個 writer 同時建立同一路徑。 |
| Desktop live | 先 `study list` 取得當次 ID，確認 Layout、Pane、商品、週期與 Volume Profile 的 inputs（150, 24, 70, 2）。OI 對照同時間的原值與日 K；VFI 逐欄比對；Profile 對照當次物件集合、抽查時間軸兩端與標籤文字。物件數可能改變，live 比對用當次集合，固定數字只用於 fixture。 |

建議依序交付 page reader 與 fixture、正規化及錯誤契約、CLI 與 artifact writer，最後以三個指標完成 Desktop 驗收。測試依現有 runner 放入 `tests/study/{unit,integration}` 與 `tests/cli/integration`，執行 `npm run test:module -- study cli artifacts context`、`npm test` 及 `npm run lint`。[測試慣例](../../tests/README.md)
