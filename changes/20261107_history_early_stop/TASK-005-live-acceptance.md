---
id: TASK-005
title: Desktop Acceptance and Documentation
status: todo
depends_on: [TASK-004]
---

# TASK-005 Desktop Acceptance and Documentation

依 [TEST_PLAN.md](./TEST_PLAN.md) 執行 L01～09，確認修正對真實 Desktop 有效。

## Work

- 記錄實際版本與 pane context，保存圖表狀態，建立真正未載入目標區間的新鮮起點。
- 單次 TAIEX history 跨初始資料範圍取得 2014-12，確認不需 workaround。
- 6902 驗證載入到上市日、上市前空區間、已耗盡起點及無 from 行為。
- 比對安全上限、observer 清理、no-restore 與預設還原。
- 更新 README／help 的完整性、timeout、stop reasons 與錯誤說明。
- 在 VERIFICATION.md 新增「修正後驗收」結果，保留修正前證據的日期與範圍。

## Acceptance

L01～09 有真實結果及還原比對；相關 local test 結果與覆蓋限制明確。
缺少 Desktop 或未執行的項目維持未完成，不用推論或 mock 結果補成通過。
只保留驗證方法與文字結果，清除本 task 產生的一次性診斷資料／scripts。
所有條件滿足後才更新 tasks 與 request 為 done；本 task 不包含 push、merge 或發布。
