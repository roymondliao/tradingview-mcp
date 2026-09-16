# Run Configuration and Resource Resolution

Status: `approved`

## Goal

一次automation run由一份versioned JSON config描述。Config保存User intent；CLI以read-only discovery解析TradingView當下資源，產生完整且固定的resolved run specification。Config不要求User查找或保存TradingView internal IDs。

```text
run-config.json (requested names)
  -> schema and file validation
  -> Tab / Layout / Pane / Watchlist / Strategy resolution
  -> immutable resolved run specification
  -> Strategy sync / Watchlist snapshot / export
```

## CLI contract

```bash
npm run tv -- strategy run --config ./run-config.json
npm run tv -- strategy run --config ./run-config.json --dry-run
```

- `--config`是V1唯一必要參數。
- V1不提供一般CLI flags覆蓋config欄位，避免執行結果無法由config重現。
- `--dry-run`不得update Pine、修改Pane、切換Layout／Watchlist／Symbol／Timeframe，或發布正式run artifacts。
- 正式run在任何mutation前必須重新執行與dry-run相同的validation與resource resolution，防止time-of-check與time-of-use之間的Desktop狀態變化。

## Configuration candidate

```json
{
  "schema_version": 1,
  "run": {
    "description": "OBV v3 baseline"
  },
  "strategy": {
    "file": "../strategies/obv-v3.pine",
    "saved_name": "obv-v3"
  },
  "target": {
    "layout": {
      "name": "OBV-S-Strategy"
    },
    "pane_index": 0,
    "watchlist": {
      "name": "tw-all-stocks"
    }
  },
  "backtest": {
    "timeframe": "1D"
  },
  "experiments": {
    "parameter_sets": [
      {
        "name": "baseline",
        "inputs": {}
      }
    ]
  },
  "output": {
    "directory": "../output",
    "format": "csv"
  }
}
```

Strategy create／update／reuse由normalized source hash自動判斷，不要求User設定sync mode。Watchlist完整讀取方式與evidence定義於[`WATCHLIST_SNAPSHOT.md`](./WATCHLIST_SNAPSHOT.md)，Parameter Sets定義於[`STRATEGY_PARAMETER_SETS.md`](./STRATEGY_PARAMETER_SETS.md)。

## Run identity

`run`本身為選填；省略、`null`或空object都表示由CLI產生identity。`run.run_id`為選填，省略時CLI產生：

```text
<strategy-slug>-<UTC timestamp>-<random suffix>
```

例如：

```text
obv-v3-20260915T083015Z-a13f8c2d
```

User可指定具實驗語意的ID，例如`obv-v3-baseline-01`。手動值只允許ASCII英數字、`-`與`_`，長度上限候選為100；不得包含path separators、`.` path segments或空白。已存在同名run directory時必須拒絕，不得隱式覆寫舊run。

## Path resolution

`strategy.file`與`output.directory`等相對路徑一律以config file所在目錄解析，不以shell current working directory解析。Dry-run回傳normalized absolute paths，但持久化artifact應在適當位置保留可攜的relative path與source hash。

Config禁止保存TradingView cookies、credentials或CDP WebSocket URL。

## Name-only requested selectors

### Chart Layout and Tab

User只設定exact Layout name：

```json
{
  "layout": {
    "name": "OBV-S-Strategy"
  }
}
```

V1要求該Layout已在TradingView Desktop某個Chart Tab中開啟。解析規則：

1. 對open Chart Tabs取得metadata。
2. 以exact、case-sensitive Layout name比對；不使用substring或模糊比對。
3. 唯一符合時固定該Tab與Layout。
4. 沒有符合時回傳`TARGET_LAYOUT_NOT_OPEN`。
5. 多個Tabs符合時回傳`TARGET_LAYOUT_AMBIGUOUS`，不猜測active或第一個Tab。

Config不保存`tab_index`、`target_id`、`layout_id`或`saved_layout_id`。Resolved specification必須保存這些執行期identity以及`layout_name`。每個會修改狀態的操作前必須read back target仍存在且Layout ownership未改變。

### Pane

`target.pane_index`必填且為0-based。CLI驗證該index存在於resolved Layout，不使用active Pane作隱式default，也不建立`pane_label`。Resolved specification保存`pane_index`、`pane_id`、原始Symbol與Timeframe。

### Watchlist

User只設定exact Watchlist name：

```json
{
  "watchlist": {
    "name": "tw-all-stocks"
  }
}
```

Dry-run必須確認name存在且唯一；不存在回傳`WATCHLIST_NOT_FOUND`，重複時回傳`WATCHLIST_AMBIGUOUS`。Config不保存`watchlist_id`；resolved specification保存`watchlist_id`、name與後續Snapshot contract要求的count／identity。

Named Watchlist不預設為active。是否能直接讀取non-active Watchlist，或需要受控切換與restore，留待完整Watchlist Snapshot討論與live evidence決定。

### Saved Strategy

User以`strategy.saved_name`描述TradingView Account中的private Saved Pine Script，並以`strategy.file`提供本次run的source of truth。Config不要求`script_id`或Pane Strategy `entity_id`。

Dry-run必須列出exact-name match count並檢查是否缺失或重複；缺失代表planned create，不是必然錯誤。重名不可猜測。Create／update／reuse、source hash normalization與Pane refresh定義於[`STRATEGY_SYNC_UPDATE.md`](./STRATEGY_SYNC_UPDATE.md)。

Resolved specification最終必須保存：

- Pine file與source SHA-256。
- Saved Script name、`script_id`與version。
- Pane Strategy Instance `entity_id`。
- Effective Inputs與fingerprint。

## Backtest determinism

- `backtest.timeframe`必填，不默認沿用Pane當下Timeframe。
- `experiments.parameter_sets[].inputs`使用exact Pine input title，不使用Study internal ID。
- Empty Parameter Set inputs表示使用batch開始時captured Base Inputs。
- 實際套用並read back的Timeframe、Inputs與fingerprint必須寫入resolved specification。

## Dry-run contract

Dry-run應儘量一次回傳所有可獨立判斷的config與resolution問題，而不是只報第一個欄位錯誤。至少包含：

- Config schema、未知欄位、值域與跨欄位validation。
- Normalized Pine／output paths、Pine file可讀性及source SHA-256。
- Generated或requested `run_id`及output collision檢查。
- Layout exact-name match count與resolved Tab／Layout metadata。
- Pane存在性與read-only inventory。
- Watchlist exact-name match count、resolved identity及可取得的宣告數量。
- Saved Strategy exact-name match count、source comparison與planned create／update／reuse action。
- Timeframe、Parameter Sets與output format validation。
- `valid`、structured `errors[]`、`warnings[]`與resolved result。

所有在read-only階段可偵測的設定錯誤或名稱問題都必須在dry-run呈現。只有依賴實際mutation或後續runtime calculation的錯誤可以留到正式run，例如TradingView在dry-run後被User改動、Pine update失敗、Strategy recalculation timeout或artifact write途中I/O failure。

正式run不把先前dry-run視為授權或cache；它必須重新解析與驗證。若解析結果不再唯一或ownership改變，必須在mutation前停止。

## Resolved run specification

正式run開始後建立immutable `run.json`，至少記錄：

- Requested config、config schema version及config content hash。
- Run ID、description與created timestamps。
- Resolved `target_id`、`tab_index`、Layout name／IDs、`pane_index`與`pane_id`。
- Resolved Watchlist name／ID與immutable Snapshot identity。
- Pine source hash、Saved Script name／ID／version、Strategy `entity_id`與Inputs fingerprint。
- Effective Timeframe與output format。

Config中的name是User-facing selector；`run.json`中的IDs是本次執行的evidence與ownership guard。User不需手動管理這些IDs。

## Confirmed decisions

- `run_id`選填並可自動產生。
- Layout、Saved Strategy與Watchlist在config中只使用exact name。
- `pane_index`必填。
- 所有可由schema、filesystem與TradingView read-only discovery判斷的錯誤都必須在dry-run呈現。
- Dry-run完全read-only；正式run再次validation後才可mutation。
- 所有internal IDs由CLI解析並寫入`run.json`。

## Deferred recovery policy

`max_attempts`、backoff、durable progress與resume不屬於本Change的Run Config schema。它們需要per-Symbol atomic checkpoint與progress contract，將由後續Durable Export／Retry／Resume change一併設計；V1不得接受但忽略`recovery`欄位，strict schema應將它回報為unsupported／unknown field。
