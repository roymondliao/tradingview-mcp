# Strategy Run Extension — Configuration Contract

Status: `proposed`

## Command inputs

```bash
tv strategy extend \
  --run-directory <succeeded-parent-run-directory> \
  --config <extended-run-config.json> \
  [--dry-run]
```

- `--run-directory`是immutable Parent durable evidence。
- `--config`使用既有Run Config schema v1，代表完整desired lineage configuration。
- `--dry-run`只讀Parent、Config、source與TradingView identities，不建立child directory或mutation。
- 不接受retry、output override或in-place flags。

## Full Config example

```json
{
  "schema_version": 1,
  "run": {
    "description": "OBV v3 extension"
  },
  "strategy": {
    "file": "../data/obv-v3.pine",
    "saved_name": "obv-v3"
  },
  "target": {
    "layout": { "name": "dev" },
    "pane_index": 0,
    "watchlist": { "name": "dev-testing-list" }
  },
  "backtest": {
    "timeframe": "1D"
  },
  "experiments": {
    "parameter_sets": [
      { "name": "baseline", "inputs": {} },
      {
        "name": "candidate-check",
        "inputs": {
          "wOBV 平滑 MA 週期": 12,
          "趨勢 SMA 週期": 20
        }
      },
      {
        "name": "rsi-check",
        "inputs": {
          "RSI 週期": 20,
          "RSI 最低門檻": 30
        }
      },
      {
        "name": "candidate-check-v2",
        "inputs": {
          "wOBV 平滑 MA 週期": 14,
          "趨勢 SMA 週期": 20
        }
      },
      {
        "name": "volume-check",
        "inputs": {
          "成交量 MA 週期": 15
        }
      }
    ]
  },
  "output": {
    "directory": "./output",
    "format": "csv"
  }
}
```

假設Parent lineage已有前三項，Extension只執行最後兩項。

## Stable Config comparison

下列fields必須與Parent persisted request相同：

```text
strategy.saved_name
strategy source_sha256 after resolving strategy.file
target.layout.name
target.pane_index
target.watchlist.name
backtest.timeframe
output.format
output.directory canonical parent root
```

允許不同：

- `run.run_id`：必須產生new child identity；若explicit，不能與任何ancestor相同。
- `run.description`。
- `experiments.parameter_sets`：只允許append-only suffix。
- Config file path及hash。

`strategy.file`可以指向不同的local canonical path；Pine identity由相同`saved_name`及既有
`normalizedPineSourceSha256()`產生的`source_sha256`決定。Child保存new Config解析出的absolute source
path供自身Resume使用。若normalized source hash不同，這不是Extension，User必須建立new standalone
Run。Output directory必須resolve為Parent Directory的parent，使lineage保持sibling layout。

## Prefix comparison

Ancestor chain按lineage order產生inherited Parameter Sets：

```js
const inherited = [
  ...root.requested.experiments.parameter_sets,
  ...extension1.requested.experiments.parameter_sets,
  ...extension2.requested.experiments.parameter_sets,
];
```

對每個`index < inherited.length`：

```text
config[index].name must equal inherited[index].name
stableJson(config[index].inputs) must equal stableJson(inherited[index].inputs)
```

Config長度小於inherited count代表delete；相同長度代表no-op；prefix不同代表mutation。
三者都不得建立child。

## New suffix validation

每個new Parameter Set：

- Name符合existing path-safe rule。
- Name不出現在ancestor chain或同一suffix。
- `inputs`是plain object。
- Exact Input name在Parent candidate schema中唯一存在。
- Value type、min/max、step、options符合current runtime schema。
- Effective Inputs從Parent persisted Base Inputs計算，不從當前Pane偶發值推導。

Config index與child-local index映射：

```text
config_index = inherited_count + run_index
lineage_index = config_index
run_index = 0..new_count-1
```

Child的`requested.experiments.parameter_sets`及`planned_experiments`只保存new suffix；top-level
`extension.new_parameter_sets[]`保存config／lineage mapping及full-sequence fingerprints。

`parent_run_fingerprint`、`lineage_fingerprint`及full-sequence fingerprints在child Resume中屬於
provenance metadata；Resume不載入Parent重新計算。Future Extend／lineage aggregation載入ancestor chain
後才完整驗證。Resume仍必須在本地驗證new suffix、plans、counts及index mapping一致。

## Child Run ID

- Config沒有explicit `run.run_id`時，使用existing generator加`extension`語意產生unique ID。
- Config有explicit Run ID時，該ID是child ID，不得等於Parent／ancestor ID。
- Child output path是`<parent-output-root>/<child-run-id>`。
- Existing path回傳`RUN_OUTPUT_EXISTS`，不提供force。

## Dry-run output

Bounded response至少包含：

```json
{
  "valid": true,
  "dry_run": true,
  "parent": {
    "run_id": "obv-v3-20261007T031045Z-c79164b0",
    "lineage_depth": 0,
    "experiments_inherited": 3
  },
  "extension": {
    "run_id": "obv-v3-extension-...",
    "experiments_requested": 5,
    "experiments_new": 2,
    "new_parameter_sets": ["candidate-check-v2", "volume-check"]
  },
  "blocked": [],
  "warnings": []
}
```

不得輸出完整Base Inputs、Watchlist Symbols或unbounded schema details。
