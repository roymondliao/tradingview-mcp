---
id: TASK-012
title: NPM Signal Forwarding Graceful Shutdown
status: done
phase: strategy-durable-export-recovery
depends_on:
  - TASK-006
  - TASK-011
blocks:
  - TASK-007-graceful-interrupt-gate
  - feature-completion
scope: cli-signal-boundary
---

# TASK-012: NPM Signal Forwarding Graceful Shutdown

## Goal

讓正式且文件化的執行路徑：

```bash
fnm exec --using=22 npm run tv -- strategy run --config <config>
```

在User只按一次`Ctrl-C`時完成graceful shutdown：停止新work、完成current bounded phase、persist`RUN_INTERRUPTED`、restore Base Inputs、release leases、輸出final JSON並以130結束。直接Node invocation只能作diagnostic，不能取代這條acceptance path。

## Reproduction evidence

2026-10-01 Run `obv-v3-20261001T020101Z-6b64187a`在baseline已19 Symbols succeeded時只按一次`Ctrl-C`：

- Shell立即回傳130。
- CLI沒有輸出final JSON或`Process: Finalizing durable Run state...`。
- `run.json.status`仍為`running`、`error: null`、empty summary。
- baseline manifest保留19 succeeded、1 running、80 pending。
- command結束後沒有存活的Node／npm／fnm process。

本機npm 11的`@npmcli/run-script/signal-manager.js`會將收到的`SIGINT`／`SIGTERM`再轉送給spawned process。Terminal foreground process-group delivery加上npm／shell forwarding可讓一次User interrupt在CLI形成一個短時間signal burst。目前CLI把任何第二個signal立即視為hard exit，因此graceful finalization被提前終止。

## Correct contract

- Signal handling以「User interrupt burst」而非raw signal callback次數計數。
- 第一個burst內的proxied／duplicated `SIGINT`／`SIGTERM`必須coalesce，只觸發一次AbortController abort。
- Coalescing window是code constant，不提供Config／CLI override。
- Window結束後的下一個signal代表獨立第二次User interrupt，維持立即exit語意。
- First signal保留原始signal name與exit code：SIGINT 130、SIGTERM 143。
- Coalescing不得延遲或重複Run finalization，也不得污染stdout JSON。
- `RUN_INTERRUPTED`使用共用compact response，只回傳Run ID、output path、必要Symbol summary、error與Resume capability；完整state留在artifacts。
- Listener與timer lifecycle必須在normal、error及signal completion後清除。

## Required implementation

- 在`withStrategyAutomationSignals()`加入fixed short signal-burst coalescing。
- 提供deterministic injected clock seam，只供tests，不形成public runtime option。
- 同一burst內不論signal name是否相同都忽略後續proxy callbacks。
- 第二個獨立burst執行既有renderer finish及immediate process exit。
- 更新D-011與manual SIGINT步驟，明確要求使用正式npm command驗證。
- Run／Resume共用的response builder對`RUN_INTERRUPTED`採compact projection，normal success／failure response不變。

## Tests

- 第一個SIGINT aborts once andreturns130。
- Immediate duplicate SIGINT不hard exit。
- Immediate SIGINT／SIGTERM forwarding burst不hard exit。
- Coalescing window後第二個signal立即hard exit。
- Listeners在所有paths清除。
- Formal Run signal finalization regression維持`RUN_INTERRUPTED`。
- Node 22／24完整unit、lint及`git diff --check`通過。
- Controlled live使用原始`fnm exec --using=22 npm run tv -- ...`，確認final JSON、run.json terminal state、exit130、lease release及same-run Resume。

## Acceptance criteria

- [x] 一次Ctrl-C經npm wrapper不再觸發Node hard exit，durable finalization可完成。
- [x] `run.json`保存`failed`／`RUN_INTERRUPTED`並輸出final response。
- [x] 第二次獨立Ctrl-C仍可立即退出。
- [x] Same-run Resume只執行non-succeeded Symbols。
- [x] Automated regression及正式command controlled live evidence通過。

## Completion record

Completed on 2026-10-01.

- `withStrategyAutomationSignals()`使用固定250ms coalescing window將immediate same／mixed forwarded signals視為同一logical interrupt burst；不新增Config或CLI option。
- 第一次burst只abort一次並保存原始signal／exit code；window後第二個independent burst維持immediate hard exit。
- 新增deterministic injected clock seam與tests，涵蓋duplicate SIGINT、mixed SIGTERM／SIGINT forwarding及later second interrupt。
- D-011與manual guide已更新，controlled live必須使用正式`fnm exec --using=22 npm run tv -- ...`路徑，只有exit130但沒有final JSON不算通過。
- Controlled Run `obv-v3-20261001T024107Z-1b9dbf99`以正式npm command在12/300 processed時按一次Ctrl-C；Node完成finalization，persist`failed`／`RUN_INTERRUPTED`、輸出final JSON並以130結束。User另確認`strategy resume`使用相同shared handler亦可graceful shutdown。
- 外層`fnm`仍會先把shell prompt交還，Node child隨後完成finalization；這是external wrapper lifecycle ordering，不得誤記成同步command completion。
- Interrupted Run／Resume使用shared compact response；正式command readback已確認terminal payload只包含必要欄位。
- Final targeted CLI／formal Run suites：56 tests passed。Node 22與Node 24完整unit suites各671/671 passed；lint為0 errors（保留3筆既有warnings），`git diff --check`通過。
- Compact Resume controlled evidence沿用同一Run `obv-v3-20261001T024107Z-1b9dbf99`：`resumed: true`、exit130、`failed`／`RUN_INTERRUPTED`，必要summary為300 requested、266 pending、33 succeeded、1 failed；response只包含contract指定欄位。
- Run第一次interrupt時已有12 succeeded，Resume後累計33 succeeded且仍使用相同Run ID；結合既有manifest immutability regression與100-Symbol controlled Resume evidence，確認successful Symbols不重新執行。
