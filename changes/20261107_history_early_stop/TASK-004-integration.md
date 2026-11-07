---
id: TASK-004
title: History Core CLI and MCP Integration
status: done
depends_on: [TASK-003]
---

# TASK-004 History Core CLI and MCP Integration

將 runtime 與 loader 接入 src/core/data.js，並保持既有 CLI／MCP 使用方式。

## Work

- 保留 chart data lock；正確處理商品 alias、D／1D 與 readiness 失敗。
- 以內外 finally 清理 observer、還原本次 mutation；處理 no-restore、外部變更與雙重錯誤。
- 保留成功結果 metadata／bars；新增 stop reasons，按 LLD 分類空結果。
- CLI 沿用 router 診斷；MCP history catch 使用既有 coreErrorResult，不丟掉 code／retryable。
- 更新現有 history fixtures 與 tests/data/unit；補 CLI／MCP contract 測試。
- output 在還原成功後才執行；不更動其他 tools 或新增 CLI timeout flags。

## Acceptance

TEST_PLAN I01～12 與完整 data regression 通過；非法參數仍在連線前拒絕。
MCP 保留 isError 與 error 文字，同時包含結構化診斷。
cleanup 失敗仍嘗試 restore，任何情況都釋放 process lock。
通過相關 data／cli／errors tests、lint 與一次全套 local tests。

交付正式實作、測試與使用說明草稿；未通過 live 驗收前不得把 request 標為 done。

## Completion record

2026-11-07 完成。交付內容及檢查結果見 [修正後驗收](./VERIFICATION.md#修正後驗收)。
