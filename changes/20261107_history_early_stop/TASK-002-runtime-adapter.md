---
id: TASK-002
title: Desktop History Runtime Adapter
status: todo
depends_on: [TASK-001]
---

# TASK-002 Desktop History Runtime Adapter

依 [LLD](./LLD.md) 建立 src/core/history-runtime.js，隔離 Desktop 狀態與事件介面。

## Work

- 驗證必要 API 與型別，輸出一致的 snapshot；unknown 不默認 false。
- 綁定 widget／series identity 與已解析商品／週期，短 CDP evaluate 都受 deadline 控制。
- 建立 observer token、事件 baseline、可選事件訂閱、lease watchdog 與冪等清理。
- requestMore 在單次 page evaluate 內原子重檢並發送；回傳 issued，而非暗示載入完成。
- Promise rejection／來源 error 僅保存有界診斷，避免 unhandled rejection。
- 建立 adapter fixtures 與正式 unit tests；不複用已刪除的診斷 scripts。

## Acceptance

TEST_PLAN U02、U03、U10、U11、U17、U19 與 U18／U21 的 adapter 部分通過。
訂閱先於請求，清理所有已註冊 callbacks；client 中斷可由 lease 自行清除。
事件缺失時仍可讀取必要狀態；必要狀態缺失時回報 unsupported。
沒有長時間 awaitPromise 綁住 CDP，也沒有直接接觸 TradingView server。

交付 runtime module、單元測試與必要介面註解，供 TASK-003 接入。
