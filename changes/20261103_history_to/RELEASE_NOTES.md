# Release v1.7.0

Target release: `1.7.0`。合併至 `fork-main` 後，由既有 Release workflow 建立 tag 與 GitHub Release。

## Changes

- `tv history` 新增 `--to`，必須搭配 `--from`，依 bar 時間戳篩選包含端點的指定區間。
- 起訖參數共用既有日期辨識。僅提供 `--from` 時，維持取得至圖表最新可用資料的行為。
  純日期為 UTC 零時；包含完整截止日需指定日末時間與時區。
- 區間外資料不占用 `max_bars`，新增 `requested_to`／`requested_to_iso`，
  實際回傳範圍及筆數由 `period`／`bar_count` 表示。
- 修正原生零交易策略報表在日期與勝率為 null 時的 snapshot 驗證及匯出對帳。
- Package 與 lockfile 同步為 `1.7.0`。更新相容的間接 runtime dependencies：
  `body-parser` 2.3.0 → 2.4.0、`iconv-lite` 0.7.2 → 0.7.3、`zod` 4.3.6 → 4.6.7，
  排除 release audit 發現的兩項 high-severity 問題；直接 dependency ranges 不變。

## Compatibility and evidence

MCP history schema 維持只接受 `from`，共用 core 回傳增加 nullable metadata。
CLI 無 `to` 的資料選取、圖表還原與輸出防覆寫行為維持原樣。

本機自動化及 release 檢查結果見 [Delivery evidence](./DELIVERY_EVIDENCE.md)。
[Desktop live 驗證](./LIVE_VERIFICATION.md) 共 11 項檢查通過；該次區間已預載，
向過去載入及外部失敗情境由 mocked runtime 測試覆蓋。
