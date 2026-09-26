# Complete Watchlist Snapshot

Status: `approved`

## Goal

依User提供的exact Watchlist name取得完整且ordered的Symbols，證明資料沒有因TradingView virtualized DOM而截斷，並建立一次Strategy run不再變動的immutable Watchlist Snapshot。

Snapshot是run的工作集合，不是Watchlist畫面行情資料。User在Snapshot建立後切換或修改Desktop Watchlist，不得使本次run靜默改變Symbols或順序。

## CLI contract

### Account inventory

```bash
npm run tv -- watchlist list
```

保留既有command，用於列出Account Watchlists。Response應提供`watchlist_id`、name、declared Symbol count與可取得時的active狀態。Name resolution使用exact、case-sensitive match，不使用substring或模糊比對。

### Active DOM view

```bash
npm run tv -- watchlist get
```

保留相容性，語意固定為目前Active Watchlist中已mount的DOM rows與可見quote fields。Response必須明確包含`source: "dom_rows"`與`complete: false`；不得將此結果用於完整Strategy Watchlist run。

### Complete named Snapshot

```bash
npm run tv -- watchlist snapshot --name "stock_list"
```

新增主要完整性入口。Optional atomic JSON output：

```bash
npm run tv -- watchlist snapshot \
  --name "stock_list" \
  --output ./stock-list.snapshot.json
```

Existing output拒絕覆寫；只有明確`--force`才可atomic replace：

```bash
npm run tv -- watchlist snapshot \
  --name "stock_list" \
  --output ./stock-list.snapshot.json \
  --force
```

V1只輸出canonical JSON，不為Watchlist Snapshot增加CSV／JSONL conversion。

不新增`watchlist switch`、`watchlist select`、`watchlist verify`或`watchlist get --name`。Named Account source可以在不切換UI的狀況下讀取非Active Watchlist；完整性validation已包含於`snapshot`。

## Resolution and capture workflow

```text
watchlist list
  -> exact name resolves one watchlist_id
  -> read Account detail ordered Symbols A
  -> validate count / identity / duplicates / invalid entries
  -> read Account detail ordered Symbols B
  -> compare modified / count / ordered fingerprint
  -> optional Active React runtime cross-check
  -> immutable Snapshot
```

Resolution rules：

- 找不到exact name時回傳`WATCHLIST_NOT_FOUND`。
- 同名結果超過一筆時回傳`WATCHLIST_AMBIGUOUS`，不可猜測第一筆。
- Snapshot不要求目標Watchlist為active，也不修改Desktop的Active Watchlist。
- React runtime只在目標剛好是active時提供額外交叉驗證；它不是named Snapshot成功的必要條件。

## Source policy

V1來源順序：

```text
Named Watchlist Account detail source
  -> optional Active React/runtime cross-check
  -> completeness cannot be proven: structured failure
```

Account detail source是TradingView登入頁面使用的same-origin internal endpoint，不是官方Account REST API。實作必須以capability detection、bounded timeout、schema validation與structured errors包裝；對應能力應納入Desktop version compatibility Gate。

DOM rows只作為diagnostic evidence，不可成為完整Snapshot provider。V1不實作controlled UI scrolling fallback，因為它會改動UI、違反dry-run read-only contract，且無法可靠證明virtualized rows沒有遺漏。

Internal source不存在、拒絕存取或schema不支援時回傳`WATCHLIST_SNAPSHOT_UNSUPPORTED`或更精確的structured error，不得fallback至DOM並宣告成功。

## Symbol and completeness validation

每個Symbol保留Watchlist原始`exchange:symbol` identity，例如`TWSE:2344`。Chart後續可能resolve成`TWSE_DLY:2344`，但Snapshot不改寫requested Symbol；per-Symbol export另外記錄requested與resolved identities。

成功Snapshot至少滿足：

```text
declared_symbol_count == returned_symbol_count
returned_symbol_count == unique_symbol_count
invalid_symbol_count == 0
stable_reads >= 2
```

- Invalid entry是不符合non-empty `exchange:symbol` identity的值。
- Duplicate entry不得靜默去重；回傳`WATCHLIST_DUPLICATE_SYMBOLS`與bounded sample，讓User修正Watchlist。
- Section／separator不當成Symbol；live discovery必須確認TradingView declared count是否包含它們，並在evidence記錄其數量。
- Count不一致時回傳`WATCHLIST_INCOMPLETE`，不可提供`complete: true`。

## Stability and identity

至少連續兩次完整讀取，並比較：

```text
watchlist_id
watchlist_name
modified
returned count
ordered Symbols
ordered-symbol fingerprint
```

內容不同時進行bounded retry；在期限內無法取得兩次相同內容則回傳`WATCHLIST_SNAPSHOT_UNSTABLE`。

`snapshot_id`由canonical Watchlist ID、name、modified與完整ordered Symbols計算。Captured timestamp不加入hash，讓內容完全相同的Snapshot維持相同identity。

Snapshot至少包含：

```json
{
  "watchlist": {
    "name": "stock_list",
    "watchlist_id": 325561734
  },
  "snapshot": {
    "snapshot_id": "sha256:...",
    "captured_at": 0,
    "captured_at_iso": "1970-01-01T00:00:00.000Z",
    "source": "account_detail",
    "declared_symbol_count": 448,
    "returned_symbol_count": 448,
    "unique_symbol_count": 448,
    "invalid_symbol_count": 0,
    "stable_reads": 2,
    "complete": true
  },
  "symbols": ["TWSE:1210", "TWSE:1215"]
}
```

實際timestamp由capture time產生；範例的Unix epoch只用來表達Unix milliseconds與ISO companion欄位。

## Dry-run and run integration

`strategy run --dry-run`重用相同Core Snapshot service，實際讀取並驗證完整ordered Symbols，但stdout可以只回傳count、fingerprint及bounded first／last samples，避免預設印出大型清單。Dry-run不發布Snapshot artifact。

正式run將完整Snapshot持久化至`run.json`或專用`watchlist.json`；artifact placement留待durable output contract固定。Run永遠依該Snapshot順序處理，不重新讀取Active DOM rows。

Resume時重新解析同名Watchlist並比較Snapshot identity；內容不同時不得將新的Symbols混入舊run。是否允許明確忽略Watchlist變更並繼續，留待Resume contract決定，default必須拒絕。

## Live evidence: stock_list

Test date: `2026-09-15`

Environment：本機已登入的TradingView Desktop CDP，read-only；未切換Watchlist、Symbol、Layout或Pane。

| Check | Result |
| --- | ---: |
| `watchlist list` declared count | 448 |
| Existing DOM-based `watchlist get` | 37 |
| Account detail read A | 448 |
| Account detail read B | 448 |
| Active React runtime read A | 448 |
| Active React runtime read B | 448 |
| Unique Symbols | 448 |
| Invalid Symbols | 0 |
| Duplicate Symbols | 0 |

Evidence：

- Exact name `stock_list`只出現一次，resolved Account ID為`325561734`。
- Account detail response具有`id`、`name`、`symbols`、`modified`等欄位，`symbols`是一次回傳的array；448筆案例未觀察到pagination或截斷。
- Account A／B與React A／B的ordered-symbol SHA-256皆為`c32585eae1a55bd0db1b291c98012bd41383dcff557e3a1b6ca673926624867a`。
- Account與React的ID、name、數量及完整順序相同。
- `modified`在兩次讀取均為`2026-06-04T01:35:56.342854Z`。
- DOM只回傳37筆，實證virtualized DOM不可代表完整Watchlist。

## Remaining validation

- 使用接近1,974 Symbols的實際大型Watchlist確認Account detail source沒有其他容量上限。
- 使用包含Section／separator的fixture確認declared count語意。
- 受控修改fixture Watchlist，證明兩次讀取可偵測不穩定；測試後必須restore。
- 目標Watchlist不是active時，驗證named source仍可完整讀取且Desktop UI狀態不變。
- Provider unavailable與unexpected schema的deterministic regression fixtures。

448筆`stock_list`已足以證明V1 provider與DOM截斷問題，但不能直接取代1,974筆容量測試。

## Implementation live validation: 2026-09-16

Account內容會持續變動，因此實作驗證不以舊的448筆數量作為hard-coded成功條件，而是要求當次inventory、兩次detail reads與unique count完全一致。

| Watchlist | Account ID | Declared | Returned | Unique | Stable reads | Complete |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `stock_list` | 325561734 | 449 | 449 | 449 | 2 | true |
| `dev-testing-list` | 346958738 | 448 | 448 | 448 | 2 | true |

- `stock_list` ordered fingerprint：`sha256:097ca617f74a1697841bfa2f4f2fc0cf04167e50b19c80cd9a8d86a1b1b301ea`。
- `dev-testing-list` ordered fingerprint：`sha256:f05d6578c44a6e0c6375b84d6a7589d2714ac38668cdfde36d426dc4ce25caaf`。
- 兩者invalid／duplicate／separator皆為0，Account inventory均標示non-active，但named Snapshot仍成功，且Desktop未切換Active Watchlist。
- 完整canonical JSON以atomic single-file transaction寫入並重新parse驗證；stdout只回傳metadata、首尾sample與output資訊。
