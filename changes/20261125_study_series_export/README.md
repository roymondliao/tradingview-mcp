---
id: FEATURE-20261125-STUDY-SERIES-EXPORT
title: Pane 指標資料匯出
status: proposed
created: 2026-11-25
scope:
  - study-cli
  - pane-indicator-output
  - datetime-index
---

# Feature request · Pane 指標資料匯出

## 目的

讓使用者從指定 Saved Layout 的 Pane，選出已加入的任一 Indicator，匯出該實例在 TradingView Desktop 中可讀取的資料。逐根 K 棒的數值應能按 datetime 與行情對齊。以線、框、標籤或表格呈現的資訊也屬於匯出範圍，須保留它原有的座標、區間或表格結構。

目前 `tv values` 可讀取資料視窗的顯示值，例如 OI 的 `131.34 K`。`tv history` 提供商品 OHLCV。這次需求是用一個 CLI 入口取得同一指標的原始值和其他可讀取的輸出，讓內建、社群與帳號中的自訂指標都能使用，無須為每個指標另寫腳本。

## 預期用法

第一行是現有指令。其餘為提案，以這次在 `stg` 觀察到的 entity ID 示範。重做時應先查詢目前實例。

```sh
tv study list --saved-layout-id 206389997 --pane-index 0

# OI 的逐根數值
tv study series GOpuD0 --saved-layout-id 206389997 --pane-index 0 \
  --dataset plots --format csv --output txf-oi.csv

# VFI 的所有數值欄位
tv study series hhW5zL --saved-layout-id 206389997 --pane-index 0 \
  --dataset plots --format csv --output txf-vfi.csv

# 固定範圍成交量分布的完整可讀快照，預設為 JSON
tv study series fwGfHN --saved-layout-id 206389997 --pane-index 0 \
  --output txf-volume-profile.json
```

## 範圍與驗收

第一版讀取指定實例**目前已載入**的輸出。檔案須讓讀者辨識資料來源、時間意義、已取得的資料集及缺漏。需要更早的逐根歷史或過去某一刻的圖形快照，屬於另一種資料取得需求。

| 必驗案例 | 可觀察的驗收結果 |
| --- | --- |
| 內建 Open interest | 從指標 row 取出同一根 K 的 timestamp 和原始未平倉量，可與同時間的 OHLCV 對齊。 |
| Volume Flow Indicator | 每個數值 plot 都有獨立欄位，兩個同名 plot 均保留。逐欄對照來源，含零值、缺值、EMA of VFI 與 VFI。 |
| Volume Profile / Fixed Range (150, 24, 70, 2) | 即使數值 plot 為零，仍能用同一命令匯出該實例的框、線、標籤及可解析的時間錨點，逐類對照當次 runtime 快照。 |
| 其他任意指標 | 加入不同名稱或來源的指標後，使用同一條命令。混合型須包含多種資料集；若部分輸出無法解讀，指出缺漏與原因。 |
| 多格或同名實例 | 依 Layout、Pane 與 entity ID 唯一定位，驗證結果中的商品、週期與指標身分，涵蓋找不到實例的錯誤路徑。 |

元件分工與輸出契約見 [System design](./SYSTEM_DESIGN.md)。模組介面、資料擷取演算法、時間索引實測與驗收方式見 [Low-level design](./LLD.md)。
