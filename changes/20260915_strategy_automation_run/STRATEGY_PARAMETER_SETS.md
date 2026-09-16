# Base Strategy and Parameter Sets

Status: `approved`

## Goal

對一個已同步且固定的Base Strategy，逐一套用多組Study input values，等待TradingView完成對應的Strategy Report與Trading Data重新計算，再對相同Watchlist Snapshot輸出可比較的實驗結果。

此workflow不把每組參數誤當成Pine source update，也不為Input mutation建立新的Saved Script version。

## Terminology and module ownership

- **Source Update**：修改Pine source並儲存新的Account Saved Script version；屬於`pine`與Strategy Sync workflow。
- **Input Mutation**：修改指定Pane Study Instance的既有input values；屬於`study`。
- **Parameter Set**：repo-owned、具唯一名稱的一組User-requested input overrides；由高階`strategy run`依序執行。
- **Experiment**：固定Strategy revision、Pane Instance、Timeframe與Watchlist Snapshot下，一個Parameter Set的完整Trading export結果。

Module boundary：

```text
pine
  -> Account Saved Pine Script lifecycle

study
  -> Pane Study Instance inventory / inputs / mutation

strategy
  -> Strategy calculation / Report / Trading Data / automation run
```

Strategy是一種Study。不得新增`strategy inputs`；Input inventory與mutation維持於`study inputs get/set`。`strategy run`直接重用Study Core，不啟動低階CLI subprocess。

## Identity contract

只修改Inputs時：

| Identity | Meaning | Expected change |
| --- | --- | --- |
| `script_id` | Account Saved Pine Script | unchanged |
| `script_version` | Pine source version | unchanged |
| `source_sha256` | Pine source content | unchanged |
| `entity_id` | Pane Strategy Instance | unchanged |
| `inputs_fingerprint` | Complete effective Inputs | changed per Parameter Set |
| `snapshot_id` | Report／Trading Data result identity | recalculated and bound to new Inputs |

任一Parameter Set執行期間若`script_id`、version、source hash、`entity_id`、Layout、Pane或Timeframe意外改變，該Experiment失敗。Pine source若需要改變，必須結束目前batch、建立新的Base Strategy revision，再開始另一批Experiments。

## Parameter Sets in run configuration

Parameter Sets屬於automation run config，不是Strategy Sync input：

```json
{
  "experiments": {
    "parameter_sets": [
      {
        "name": "baseline",
        "inputs": {}
      },
      {
        "name": "fast",
        "inputs": {
          "wOBV 平滑 MA 週期": 5,
          "趨勢 SMA 週期": 10
        }
      },
      {
        "name": "slow",
        "inputs": {
          "wOBV 平滑 MA 週期": 20,
          "趨勢 SMA 週期": 60
        }
      }
    ]
  }
}
```

- `parameter_sets[].name`是repo-owned Experiment name，必填且在同一batch內唯一。
- `inputs`的keys使用exact、case-sensitive Pine input titles，不使用`in_0`等internal IDs。
- V1使用明確列出的Parameter Sets；不實作Cartesian parameter grid generation。
- Empty `inputs`表示本次Experiment使用captured Base Inputs。

Batch開始時取得一次完整Base Inputs。每一組Effective Inputs都由`Base Inputs + current Parameter Set overrides`建立，不從上一組參數繼承，避免state leakage。全部完成或失敗離開時，在`finally`嘗試恢復並read back Base Inputs。

## Study input inventory

既有CLI位置正確，維持：

```bash
fnm exec --using=22 npm run tv -- study inputs get <entity-id> \
  --layout-id <layout-id> \
  --pane-index 0
```

Study Core必須同時讀取：

- `study.getInputsInfo()`：input ID、name、type、group、default與constraints。
- `study.getInputValues()`：input ID與current value。

兩者依input ID合併。每個user-facing item至少具有`id`、`name`、`type`、`value`，並在可用時提供`group`、`default_value`、`min`、`max`、`step`與`options`。

Example：

```json
{
  "id": "in_3",
  "name": "wOBV 平滑 MA 週期",
  "type": "integer",
  "group": "wOBV 設定",
  "value": 10,
  "default_value": 10,
  "constraints": {
    "min": 3,
    "max": 30,
    "step": 1
  }
}
```

Time input保留Unix milliseconds並增加ISO companion，例如`value_iso`與`default_value_iso`。

Internal／non-user fields，例如`text`、`pineId`、`pineVersion`、`pineFeatures`與`__profile`不得出現在user-facing list。Missing name不可用ID假裝成name；該item不可供name selector使用，並需提供bounded diagnostic。

## Study input mutation

### Internal ID selector

```bash
fnm exec --using=22 npm run tv -- study inputs set <entity-id> \
  --inputs '{"in_3":5,"in_7":20}' \
  --layout-id <layout-id> \
  --pane-index 0
```

### User-facing name selector

```bash
fnm exec --using=22 npm run tv -- study inputs set <entity-id> \
  --inputs-by-name '{"wOBV 平滑 MA 週期":5,"趨勢 SMA 週期":20}' \
  --layout-id <layout-id> \
  --pane-index 0
```

`--inputs`與`--inputs-by-name`互斥；同時提供回傳`STUDY_INPUT_SELECTOR_CONFLICT`，兩者皆未提供回傳`STUDY_INPUTS_REQUIRED`。

Name selector使用exact、case-sensitive match。不存在回傳`STUDY_INPUT_NOT_FOUND`；多個exposed inputs使用相同name時回傳`STUDY_INPUT_NAME_AMBIGUOUS`。Ambiguous name仍可由低階`--inputs`使用ID處理，但automation Pine source應使用唯一input titles。

### All-or-nothing validation

Mutation前必須解析並驗證全部requested keys：

- ID／name存在且唯一。
- Input不是internal、hidden或不可設定欄位。
- Value符合bool、integer、float、time、string或enum type。
- 可用時驗證`min`、`max`、`step`與`options`。

任一欄位失敗時不得呼叫`setInputValues()`；不可套用已知欄位後只把unknown keys列在成功response。全部有效時才一次提交完整mutation，接著取得完整readback並確認requested values。

Set response至少包含selector mode、requested inputs、每個resolved ID／name、previous／requested／actual value、完整effective Inputs fingerprint及Strategy的`report_state: "recalculating"`。

Study module不等待Report ready。Indicator也是Study；等待fresh Strategy calculation屬於Strategy Runtime／Run Orchestrator。

## Parameter Set execution

```text
capture fixed Strategy and Base Inputs
  -> capture immutable Watchlist Snapshot
  -> for each Parameter Set in declared order
       -> effective = Base Inputs + this set overrides
       -> capture before Report state
       -> resolve names and validate all values
       -> apply through Study Core
       -> read back complete effective Inputs
       -> assert fixed script / version / entity / context
       -> wait for fresh stable Strategy Report
       -> export same Watchlist Snapshot
       -> persist Experiment identity and results
  -> finally restore and verify Base Inputs
```

Freshness不可只比較總損益或交易次數；不同Inputs可能合法產生相同結果。Report必須綁定requested effective `inputs_fingerprint`，並在可觀察到recalculation／unavailable transition或可信generation change後達到至少兩次相同的stable state。

## Dry-run validation

`strategy run --dry-run`取得固定Base Strategy的完整Input Catalog，並對每個Parameter Set：

- Exact resolve全部names至internal IDs。
- 驗證duplicate／missing names及value type／constraints。
- 建立完整Effective Inputs與fingerprint。
- 顯示requested name、resolved ID、base value與requested value。
- 不呼叫`setInputValues()`，不觸發Strategy recalculation。

本use case假設Base Strategy已存在於指定Pane，因此dry-run可以從runtime完整驗證name mapping。若未來支援在同一次run建立尚不存在的Strategy，read-only dry-run如何證明runtime input schema必須另外定義，不可假裝已完成驗證。

## Live evidence: input metadata

Test date: `2026-09-15`

在`OBV-S-Strategy` Layout、Pane 0的Active Account Strategy執行read-only discovery：

- 現有`study inputs get`回傳41個`in_0`至`in_40` values，但沒有任何name，確認目前public response不足。
- `study.getInputValues()` items只有`id`與`value`。
- `study.getInputsInfo()`成功回傳46個metadata items；其中包含internal Pine fields與user-configurable inputs。
- User input `in_3`回傳name `wOBV 平滑 MA 週期`、type `integer`、group `wOBV 設定`、min `3`、max `30`、step `1`。
- User input `in_4`回傳name `最低價格變化門檻 (%)`、type `float`、min `0`、max `2`、step `0.1`。
- Discovery沒有呼叫`setInputValues()`或修改Desktop狀態。

此evidence證明input name與constraint mapping應來自TradingView runtime metadata，不需要以regex解析Pine source。

## Deferred

- Automatic Cartesian grid generation。
- Cross-Pane或parallel Parameter Set execution。
- 對不存在於Pane的新Strategy進行完全read-only input schema validation。
- Pine source update後的Input schema migration；屬於Strategy Sync／Pane refresh discussion。

