---
id: TASK-006
title: Parameter Set Planning and Execution
status: done
phase: strategy-automation-run
depends_on:
  - TASK-002
  - TASK-004
  - TASK-005
blocks:
  - TASK-007
scope: strategy-experiments
---

# TASK-006: Parameter Set Planning and Execution

## Goal

在fixed latest Strategy revision與Pane Instance上，建立多組explicit Parameter Sets的deterministic planning、name-to-ID resolution、Inputs mutation、fresh calculation等待與Base Inputs restore workflow。

## Requirements

### In scope

- Unique／path-safeParameter Set names與declared ordering。
- Base Inputs capture與complete fingerprint。
- 每組Effective Inputs=`Base + current overrides`，不繼承上一組。
- Candidate／Runtime Schema雙重value validation與name-to-current-ID mapping。
- Study Input mutation、complete readback與fixed identity assertions。
- Before Report state、recalculation／freshness／stable Report wait。
- Per-Experiment identity與metadata projection。
- `finally`Base Inputs restore及readback。

### Out of scope

- Parameter grid generation／optimizer。
- Symbol／Watchlist export與artifact format。
- Cross-Pane或parallelParameter Sets。
- Durable progress、retry或resume。

### References

- [`Base Strategy and Parameter Sets`](./STRATEGY_PARAMETER_SETS.md)
- [`LLD Parameter Sets`](./LLD.md#new-srccorestrategy-parameter-setsjs)

## Design

新增`strategy-parameter-sets.js`，pure planner產生每組requested names、resolved current IDs、complete Effective Inputs與fingerprint。Runtime executor每次從Base plan套用，不將上一組actual state作為下一組base；即使相鄰組相同，也要read back fixed identity後才可視為no-op。

Freshness不依賴metrics差異。Mutation前保存runtime state；mutation後要求expectedInputs fingerprint、calculation transition或可信generation change，以及至少兩次相同stable Report state。Operation callback供TASK-007執行existing Trading export。

## Verification and Delivery

### Tests

- Empty baseline與multiple explicit sets ordering。
- Base merge不受previous actual state污染。
- Name mapping、reordered runtime IDs、type／constraint／ambiguous failures。
- Same-value no-op與changed value mutation。
- Fixed script／version／entity／context assertions。
- Report transition、same-metrics-but-new-inputs、timeout與runtime error。
- Operation failure仍restore Base；restore mismatch使run failure。
- Experiment identity／timestamps／fingerprints determinism。

### Acceptance criteria

- [x] 多組Parameter Sets依config順序執行。
- [x] 每組都由相同Base Inputs建立。
- [x] Export callback前已確認Inputs readback與fresh stable Report。
- [x] Batch結束或任何failure後Base Inputs完成restore readback。
- [x] Source version或`entity_id`中途改變時立即停止。

### Validation commands

```bash
fnm exec --using=22 npm run lint
fnm exec --using=22 npm run test:unit
fnm exec --using=22 npm run test:cli
```

### Deliverables

- Parameter Set planner／executor、freshness integration、restore guard、tests與experiment metadata model。

## Completion record

Completed on 2026-09-17.

Implemented:

- 擴充`strategy-parameter-sets.js`，提供完整internal execution plan、deterministic Experiment ID、`withParameterSet()`、`restoreBaseInputs()`與sequential`executeParameterSets()`application service；既有dry-run plan仍維持bounded response，不輸出完整Effective Inputs。
- Parameter Set name在Core再次驗證unique／path-safe；每組Effective Inputs固定由同一份captured Base合併current overrides，並依當下Runtime Catalog exact name映射至current internal IDs。
- 每組執行前後都重新取得指定target／Pane，驗證唯一matching`script_id`、version與`entity_id`；Runtime Input IDs／names／types或Chart context改變立即停止。
- Mutation只提交相對current state有差異的IDs，但每次以完整Effective Inputs fingerprint readback驗證，避免上一組state leakage；same-value no-op仍完成identity、Inputs與stable Report readback。每組開始也必須等於executor預期的previous Effective Inputs，外部或callback干擾會立即停止並restore。
- Mutation前保存bounded Report state；mutation後重用Strategy Runtime freshness lifecycle，要求Input fingerprint已切換且Report以1秒polling連續2次stable，才呼叫TASK-007預留的operation／export callback。
- Batch使用單一Chart Session mutex依宣告順序執行。成功、callback failure、calculation timeout都在`finally`恢復Base Inputs；restore mismatch或fixed identity改變時回傳`PARAMETER_SET_RESTORE_FAILED`且不可宣告成功。
- Experiment metadata包含Parameter Set order／name／requested與resolved overrides、fixed Strategy identity、Base／Effective fingerprints、Unix／ISO timestamps及stable Report snapshot identity。
- 統一Strategy Runtime與Study Core的Input fingerprint provider：兩者皆只納入visible／non-hidden Runtime Inputs、排除internal fields，並使用numeric ID ordering；避免相同35個Inputs因Runtime原先額外納入hidden fields及lexicographic sorting而得到不同hash。

Deterministic validation:

- 新增`tests/strategy_parameter_execution.test.js`並納入`test:unit`／`test:all`，涵蓋declared ordering、Base isolation、reordered IDs、invalid names、deterministic identity、same-value no-op、changed mutation、same metrics fresh Report、external Input interference、callback／timeout restore、restore mismatch與fixed identity change。
- 既有Strategy Runtime tests新增Study／Runtime fingerprint canonicalization contract。
- `fnm exec --using=22 npm run test:unit`：518 passed。
- `fnm exec --using=22 npm run test:cli`：31 passed。
- `fnm exec --using=22 npm run lint`：0 errors；3個既有warnings不在本Task範圍。

Live Desktop 3.4.0 evidence:

- Target為Layout`dev`／Pane 0／`TWSE_DLY:2330`／`1D`，Strategy`obv-v3`維持`script_id=USER;639b20c65fbb456cb769054b72623d40`、version`3.0`、`entity_id=hdn44B`。
- 受控Parameter Set將`wOBV 平滑 MA 週期`由Base`10`改為`11`；使用1秒polling interval，完整Inputs readback後Report`fresh=true`且stable reads為2，operation callback觀察值為`11`。
- `finally`成功將同一Input由`11`恢復為`10`，restore Report再次stable reads 2；final Base fingerprint為`d084bf5c1174577630a6be564cf7ed081c899f7c3bbfd2ba1a7b120e425fa219`、count 35。
- 測試前置的fingerprint mismatch發生在任何mutation前，guard正確停止且Base未變；修正provider後才執行上述controlled mutation。
