---
id: TASK-010
title: Resume Stable Identity and Runtime Binding Boundary
status: done
phase: strategy-durable-export-recovery
depends_on:
  - TASK-005
  - TASK-006
blocks:
  - TASK-007-controlled-resume-gate
  - feature-completion
scope: resume-identity-correction
---

# TASK-010: Resume Stable Identity and Runtime Binding Boundary

## Goal

修正Resume把current Chart Symbol／timeframe及其他volatile runtime bindings誤當成immutable Experiment identity的問題。Existing artifact-v2 Run必須能在crash後Chart停留於不同Symbol、Desktop target ID改變或Pane Strategy entity ID重新綁定時，沿用同一Run ID並只執行non-succeeded Symbols。

## Reproduction evidence

Run `obv-v3-20260930T092721Z-5b23bba5`的frozen Watchlist validation為100/100 valid，baseline為100/100 succeeded，candidate-check已有9 succeeded並在index 9／`TWSE:2347`留下`running`entry。Resume失敗：

```text
RUN_RESUME_ARTIFACT_INVALID
experiment.json target does not match the persisted Run plan.
```

Artifacts差異只有volatile current Symbol：

- Resume更新後`run.json.resolved.target.symbol = TWSE_DLY:2347`。
- Existing `experiment.json.target.symbol = TWSE_DLY:9958`。
- Layout、saved Layout、Pane、Strategy script/version/source、Watchlist Snapshot及Experiment fingerprints皆相同。

## Correct identity contract

### Stable Run／Experiment identity

- Run ID與canonical Run Directory。
- Artifact schema version。
- Pine source SHA256與Candidate schema fingerprint。
- Layout name及saved Layout identity。
- Pane index／Pane ID。
- Strategy script ID、version及source SHA256。
- Frozen Watchlist Snapshot ID、ordered fingerprint、count及ordered Symbols。
- Backtest timeframe與output format。
- Base Inputs、Parameter Set、effective Inputs及Experiment fingerprints。

### Volatile runtime binding

- Current Chart Symbol。
- Current Chart timeframe／resolution。
- CDP target ID、tab index及session identity。
- Pane Strategy entity ID。

Volatile fields可保留在artifact作bounded audit evidence，但不得參與immutable Experiment equality。每次Run／Resume invocation應從current Pane建立新的in-memory restore baseline。

## Required implementation

- Durable Experiment identity validation對Strategy與target使用shared stable projections，不比較完整runtime objects。
- Existing Experiment繼續使用persisted immutable artifact；rebound context只傳給本次runtime execution與restore。
- Stable Layout／Pane／script／version／source drift仍必須fail closed。
- Manifest requested Symbols必須繼續與`watchlist.json`及Run Watchlist identity完全一致。
- 不修改既有Run artifacts來繞過驗證；修正必須向後相容目前artifact-v2。
- Error taxonomy維持`RUN_RESUME_ARTIFACT_INVALID`／`RUN_RESUME_IDENTITY_MISMATCH`的既有邊界。

## Tests

- Existing Experiment target Symbol／resolution與rebound context不同仍可Resume。
- Volatile target ID／tab index與Strategy entity ID改變仍可Resume。
- Stable saved Layout／Pane identity改變仍拒絕。
- Stable Strategy script/version/source改變仍拒絕。
- Resume只執行non-succeeded Symbols，既有succeeded artifacts不變。
- Original persisted Experiment target audit snapshot不被Resume覆寫。
- Node 22／24 full unit、lint及`git diff --check`通過。

## Acceptance criteria

- [x] `target.symbol`與`target.resolution`不參與Experiment identity validation。
- [x] `target_id`、`tab_index`及Strategy `entity_id`不參與Experiment identity validation。
- [x] Stable target／strategy fields及所有Run／Watchlist／Experiment fingerprints仍被驗證。
- [x] Reproduction Run在不修改artifacts的前提下可重新Resume。
- [x] Regression tests與完整gates通過。

## Completion record

Completed on 2026-09-30.

- Durable Experiment與Resume artifact audit共用stable identity projections。Strategy只比較script ID、version與source SHA256；target比較Layout name、saved Layout identity及Pane index／Pane ID。
- Current Symbol／resolution、target ID、tab index、runtime Layout URL IDs及Strategy entity ID保留為runtime／audit binding，不參與immutable Experiment equality。
- Resume成功rebind後會更新`run.json`的current target與Strategy entity audit binding，但existing `experiment.json`保持原始immutable snapshot且不被覆寫。
- 新增end-to-end Resume regression：existing Experiment保留原Symbol／resolution／entity，runtime同時改變Symbol、resolution、target ID、tab index、runtime Layout IDs及entity ID，只執行原始Experiment 2/3的一個non-succeeded Symbol並成功完成。
- Stable Strategy script drift及saved Layout drift仍以`RUN_RESUME_ARTIFACT_INVALID`拒絕。
- 對reproduction Run `obv-v3-20260930T092721Z-5b23bba5`完成read-only preparation：candidate-check選取91 Symbols、rsi-check選取100 Symbols；persisted target `TWSE_DLY:9958`與current Run target `TWSE_DLY:2347`不再造成identity failure，且未修改任何artifact。
- Targeted durable Experiment／Resume／identity／Run suites：42 tests passed。Node 22與Node 24完整unit suites各665/665 passed；lint為0 errors（保留3筆既有warnings），`git diff --check`通過。
