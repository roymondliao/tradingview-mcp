# Candidate Pine Input Schema

Status: `approved`

## Goal

在`strategy run --dry-run`的read-only階段，對local Pine candidate source建立足以驗證`experiments.parameter_sets`的Input Schema。若local source需要update，Config與新版Inputs不相容必須在Account mutation前被偵測。

Update後再以new Pane Instance的`getInputsInfo()`取得authoritative Runtime Schema並read back；兩階段任一不一致都不可開始Trading export。

## Why a hybrid provider

TradingView `translate_light` compiler已證明可以辨識User Input variables與inferred types，但沒有直接提供完整UI Input metadata。完整Candidate Schema因此由兩個互相驗證的來源組成：

```text
TradingView compiler
├── compile errors / warnings
├── Input variable names
└── compiler-inferred value types

Minimal Local Declaration Scanner
├── static title
├── Pine input function type
├── default literal / expression
├── group
└── min / max / step / options
```

不建立完整Pine AST／interpreter，也不解析opaque compiled IL。

## Pine check extension

目前`pine check`只保留compile errors／warnings。應將compiler `result.variables2[].docs`中`type`以`input `開頭的items sanitize為：

```json
{
  "input_variables": [
    {
      "variable_name": "wobvMaLen",
      "inferred_type": "int"
    }
  ]
}
```

這是Compiler Input Variables，不得宣告成完整`input_schema`。Response不可包含完整private source、opaque compiler payload或非必要User variables。

## Minimal scanner

Scanner只針對compiler已確認的Input variable names，在local source中定位對應的top-level assignment與`input.<type>(...)`call：

```text
normalize CRLF / CR to LF
  -> token-aware skip strings and line comments
  -> locate compiler Input variable assignment
  -> balanced scan of call parentheses / nested calls / arrays
  -> split only top-level positional and named arguments
  -> resolve bounded static literals
  -> canonical declaration item + source location + fingerprint
```

Parser是generic call parser；不同Input types由registry normalization，不為每一種function建立一套parser。V1 registry至少涵蓋`bool`、`int`、`float`、`string`、`time`、`source`、`symbol`、`timeframe`、`session`、`color`、`price`、`text_area`與`enum`。

Legacy無suffix的`input()`可先回傳structured unsupported error。

## Authoring contract

Automation使用的每個`input.*()`必須具有非空、static、全Strategy唯一的literal `title`：

```pine
wobvMaLen = input.int(
    10,
    title="wOBV 平滑 MA 週期",
    minval=3,
    maxval=30,
    step=1,
    group="wOBV 設定")
```

- Missing／empty title：`PINE_INPUT_STATIC_TITLE_REQUIRED`。
- 無法靜態解析title：`PINE_INPUT_NAME_UNRESOLVED`。
- Duplicate title：`PINE_INPUT_NAME_AMBIGUOUS`。

Config使用exact、case-sensitive title。Variable name與declaration order保留為evidence，但不是User-facing selector；Candidate Schema不建立或猜測`in_x`。

## Literal and expression policy

Scanner只求值bounded literals：boolean、integer、float、quoted string、negative numeric與literal arrays。Nested default，例如`timestamp("1 Jan 2010")`或`close`，保留canonical raw expression，不在local執行。

Constraints需要影響Parameter Set validation但無法靜態求值時，dry-run回傳`PINE_INPUT_CONSTRAINT_UNRESOLVED`，不可猜測。Update後的actual default與constraint由Runtime Schema確認。

`input.time()`在compiler symbol table呈現`input int`是合法representation；Candidate item同時保存`pine_input_type: "time"`與`runtime_value_type: "int"`。

## Candidate schema

```json
{
  "schema_version": 1,
  "source_sha256": "...",
  "input_count": 16,
  "inputs": [
    {
      "declaration_index": 3,
      "variable_name": "wobvMaLen",
      "name": "wOBV 平滑 MA 週期",
      "pine_input_type": "int",
      "runtime_value_type": "int",
      "default_value": 10,
      "group": "wOBV 設定",
      "constraints": {
        "min": 3,
        "max": 30,
        "step": 1
      },
      "location": {
        "line": 25,
        "column": 1
      },
      "declaration_sha256": "..."
    }
  ],
  "input_schema_fingerprint": "sha256:..."
}
```

Schema fingerprint使用ordered canonical items的name、types、default／expression、group、constraints與options。Source location不加入fingerprint。

## Current／candidate comparison

Current Schema由Account current source建立；Candidate Schema由本文件的hybrid provider建立。Comparison以exact name為identity，輸出`added`、`removed`與field-level `changed`。V1的change classification只比較`type`、`default_value`／`default_expression`、`min`與`max`；`group`、declaration order／location、`step`與`options`不構成schema diff。Parameter Set value validation仍可使用available的`step`與`options`。

- Reorder只改runtime ID／declaration order，不使name-based Config失效。
- Rename表現為removed old name＋added new name；Config仍引用old name時blocking error。
- Added Input未被Parameter Sets覆蓋時使用new default並warning `PARAMETER_SET_NEW_INPUT_DEFAULTED`。
- Removed／renamed name仍被引用：`PARAMETER_SET_INPUT_NOT_FOUND`。
- Type、min或max變更使value不合法：對應type／range blocking error；`step`與`options`雖不列入diff，仍由value validation檢查。

Pine `strategy()`properties不屬於`input.*()`Candidate Schema；若未來自動化Initial Capital、Commission等設定，使用獨立`backtest.properties`contract，不與Parameter Sets混合。

## Two-phase validation

Dry-run：

```text
normalize and compare Account/local source hashes
  -> pine check and sanitized Compiler Input Variables
  -> Minimal Scanner candidate declarations
  -> cross-check count / variable / type
  -> compare Current vs Candidate Schema
  -> validate every Parameter Set
  -> any error: valid=false, do not update Account
```

Formal run重做相同preflight。若通過並完成Account update／add latest：

```text
new Instance getInputsInfo / getInputValues
  -> authoritative Runtime Schema
  -> compare Candidate vs Runtime names / types / constraints
  -> resolve names to new runtime IDs
  -> validate Parameter Sets again
  -> mismatch: remove new, keep old, stop
  -> match: continue Inputs application and Report freshness
```

Candidate與Runtime不一致回傳`STRATEGY_INPUT_SCHEMA_READBACK_MISMATCH`且不可移除old Instance。

## Live compiler evidence

Test date: `2026-09-15`

使用`data/obv-v3.pine`對目前`pine check`相同的TradingView `translate_light` endpoint執行read-only bounded response discovery：

- HTTP 200，compile成功。
- Result keys只有`variables2`、`functions2`、`types`與`enums`；沒有直接`inputs`、`metaInfo`或Input Schema欄位。
- `variables2`包含一個`User Variables` group，共62個variables，每個item只有`name`與`type`。
- 以`type` prefix `input `篩選後得到16個Input variables，與`data/obv-v3.pine`的16個`input.*()`宣告一致。
- Compiler正確辨識`useDateFilter: bool`、`wobvMaLen: int`、`minChangePct: float`等型別。
- Compiler沒有提供title、default、group、constraints或options，無法單獨完成name-based Parameter Set validation。
- Probe沒有更新Account、Pane或repo files，也沒有輸出完整source或opaque compiler payload。

## Deterministic tests

- Compiler variables sanitize與non-input filtering。
- Single-line／multi-line input declarations。
- Nested`timestamp()`、strings與comments中的假`input.*`。
- Named／positional arguments與escaped static title。
- Missing、dynamic與duplicate title。
- All registry types與legacy unsupported case。
- Literal default／constraints及unresolved expressions。
- Added／removed／renamed／reordered／type／constraint schema diff。
- Parameter Set valid、missing、ambiguous、type、range、step與option cases。
- Candidate／Runtime readback match與mismatch。
- `data/obv-v3.pine`golden fixture：16 Compiler Input Variables與16Candidate Inputs。
