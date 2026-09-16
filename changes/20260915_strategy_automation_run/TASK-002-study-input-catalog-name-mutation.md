---
id: TASK-002
title: Study Input Catalog and Name Mutation
status: todo
phase: strategy-automation-run
depends_on: []
blocks:
  - TASK-004
  - TASK-005
  - TASK-006
scope: pane-study-instance
---

# TASK-002: Study Input Catalog and Name Mutation

## Goal

讓`study inputs get`提供每個user-facing Input的name與完整metadata，並讓`study inputs set`支援strict ID／name selectors、all-or-nothing validation與完整readback，供User手動操作與Strategy Run重用。

## Requirements

### In scope

- 合併`getInputsInfo()`與`getInputValues()`。
- Filter internal／hidden／fake fields並保留stable ordering。
- Response fields：ID、name、type、group、value、default、constraints、options。
- Time values保留Unix milliseconds與ISO companions。
- `--inputs`by ID與`--inputs-by-name`by exact title，mutually exclusive。
- 全部selectors／values在mutation前解析與驗證；unknown不可partial apply。
- Post-mutation complete catalog readback與Inputs fingerprint。
- Extend existing`study_get_inputs`／`study_set_inputs`MCP schemas與same Core behavior。

### Out of scope

- 等待Strategy Report recalculation。
- Pine source schema extraction。
- Parameter Sets loop或Strategy Trading export。

### References

- [`Base Strategy and Parameter Sets`](./STRATEGY_PARAMETER_SETS.md#study-input-inventory)
- [`LLD Study module`](./LLD.md#extend-srccorestudiesjs)

## Design

建立pure catalog merge、selector resolution、value validation與fingerprint helpers。`setStudyInputs()`先產生完整mutation plan；任何missing、ambiguous、type、range、step或option error都不呼叫page mutation。成功set後重新取得catalog，逐一驗證actual values並回傳complete effective fingerprint。

既有允許known keys成功、unknown keys只列於response的partial semantics改為strict failure；release note必須記錄此behavior change。

## Verification and Delivery

### Tests

- Info／value merge、ordering、missing metadata與internal fields filtering。
- Name、type、group、default、constraints與time ISO companions。
- By-ID／by-name success、same-value no-op與fingerprint determinism。
- Missing／ambiguous／hidden selector與selector conflict。
- Bool／integer／float／time／string／enum及range／step／optionsvalidation。
- Any invalid field causes zero mutation calls。
- Post-mutation mismatch failure與CLI／MCP parity。

### Acceptance criteria

- [ ] `study inputs get`對可name-select的Inputs回傳non-empty `name`。
- [ ] `--inputs`與`--inputs-by-name`都能正確設定並read back。
- [ ] Invalid request不產生partial mutation。
- [ ] Strategy set明確回傳`report_state: recalculating`但不等待Report。
- [ ] Response與diagnostics不包含internal Pine payload。

### Validation commands

```bash
fnm exec --using=22 npm run lint
fnm exec --using=22 npm run test:unit
fnm exec --using=22 npm run test:cli
fnm exec --using=22 npm run tv -- study inputs get <entity-id> --layout-id <layout-id> --pane-index 0
```

### Deliverables

- Study Input Catalog、strict mutation resolver、CLI／MCP extensions、tests、documentation與live readback evidence。

## Completion record

Not started.

