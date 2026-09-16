# Strategy Source Sync and Update

Status: `approved`

## Goal

讓`strategy run`以User指定的local Pine file作為source of truth，在任何Parameter Set執行前，自動確認Account Saved Strategy與指定Pane Strategy Instance載入相同且已驗證的source revision。

Source synchronization不等於Parameter Set input mutation：

- Pine source hash改變時才create／update Account Saved Script version並refresh Pane Instance。
- 只調整Study inputs時，`script_id`、script version、source hash與`entity_id`維持不變。

## Layers

```text
strategy run orchestration
  -> Pine Core: analyze / check / list / get / create / update
  -> Study Core: list / get / add / inputs / remove
  -> Strategy Runtime: active source / fresh calculation verification
```

`strategy run`重用Core services，不啟動`pine`或`study`CLI subprocess。Pine、Study與Strategy的module ownership不因高階orchestration而改變。

## Confirmed Account sync contract

Config提供local Pine file與Account Saved Strategy exact name，不要求User提供`script_id`。CLI讀取local source、計算SHA-256，並以exact、case-sensitive name查找Account Saved Strategies。

| Exact-name matches | Source comparison | Planned action |
| ---: | --- | --- |
| 0 | — | `create` private Account Saved Strategy |
| 1 | Account hash equals local hash | `reuse` existing version |
| 1 | Account hash differs from local hash | `update` same `script_id` to a new version |
| >1 | — | fail with `STRATEGY_NAME_AMBIGUOUS` |

在任何Account mutation前必須完成offline analysis、TradingView server compile check、type=`strategy` validation與exact-name ambiguity validation。Compile failure不得create或update。

Create／update只操作目前登入Account的private Saved Pine Script；不得Publish成Public、Protected、Invite-only或Community Script。

## Dry-run

```bash
npm run tv -- strategy run --config ./run-config.json --dry-run
```

Dry-run至少回傳：

```json
{
  "strategy_sync": {
    "action": "update",
    "saved_name": "obv-v3",
    "script_id": "USER;...",
    "current_version": 15,
    "current_source_sha256": "...",
    "requested_source_sha256": "...",
    "source_changed": true
  }
}
```

- `action`為`create`、`update`或`reuse`。
- Create時`script_id`與version尚不存在，使用`null`並明確標示planned values unavailable；不得製造假的ID。
- Dry-run不得create／update Saved Script、add／remove Pane Instance、set Inputs或等待mutation造成的Report。
- Name不存在且action為planned `create`不是config error；重名、local file無法讀取、compile failure或Account type不符是blocking error。

## Formal run Account workflow

```text
read local Pine source
  -> compute source SHA-256
  -> offline analyze
  -> TradingView server compile check
  -> exact-name Account resolution
       -> missing: create private Strategy
       -> same hash: reuse
       -> different hash: update same script_id
  -> pine get readback
  -> verify type / saved name / source hash / version
```

正式`strategy run`自行完成此workflow，不要求User先執行`pine update`。User執行正式run即授權對config所指定exact-name Saved Strategy進行必要的private create／update；run仍必須重做dry-run validation，避免Desktop或Account狀態已改變。

比較source前必須先正規化換行：

```text
CRLF -> LF
CR   -> LF
```

接著才計算SHA-256。不得因TradingView Account source使用CRLF、本機檔案使用LF而誤判source changed並建立不必要的新version。

Update成功後：

- `script_id`必須保持不變。
- Account script version必須增加並可read back。
- Readback source hash必須等於local source hash。
- Account update成功不代表既有Pane Instance已載入新版本。

## Known live behavior

先前Desktop 3.4.0 live test已確認：

```text
Account Saved Script v1 + Pane Instance v1
  -> pine update creates Account v2
  -> existing Pane Instance remains v1 with the same entity_id
  -> remove old + add version=last loads v2 with a new entity_id
```

因此正式run在Account create／update／reuse後，都必須驗證指定Pane Instance的`script_id`與loaded version；只因`pine update`成功不可開始Parameter Sets。

## Confirmed Pane refresh transaction

指定Pane中同一Saved Script的Instance處理規則：

| Matching Instances | Loaded version | Action |
| ---: | --- | --- |
| 0 | — | add Account latest |
| 1 | equals verified Account latest | reuse |
| 1 | stale | execute safe refresh transaction |
| >1 before sync | any | fail with `STRATEGY_INSTANCE_AMBIGUOUS` |

Safe refresh順序：

```text
capture old Instance identity + complete Inputs
  -> keep old Instance in Pane
  -> add same script_id with version=last
  -> verify exactly one new entity_id
  -> verify new pineId and pineVersion equal Account latest
  -> compare or migrate complete Inputs
  -> verify new Strategy is active and Report reaches ready/stable state
  -> remove old entity_id
  -> verify exactly one matching latest Instance remains
```

新Instance未完成全部驗證前，不得移除舊Instance。`entity_id`在refresh後會改變，正式run必須使用new ID並寫入resolved `run.json`。

Failure rules：

- Account update失敗：Pane不mutation。
- Add latest失敗：舊Instance保持不變。
- New `script_id`／version／Inputs／Report驗證失敗：移除本次建立的new Instance，保留old。
- Old removal失敗：不得宣告sync成功；回傳新舊identities與bounded cleanup state，不可猜測任一Instance已被安全接管。
- 只清理本次transaction建立且ownership已read back的新Instance。

若Account update成功但Pane refresh失敗，這是可重試的partial sync state：

```text
Account: local source已是latest，因此下次action=reuse
Pane: loaded version stale，因此下次action=refresh
```

下一次run不得再次建立相同source的Account version。

## Live evidence: dev obv-v3 refresh

Test date: `2026-09-15`

Target：

- Layout name `dev`、runtime `layout_id=aQoXnpKX`、Pane 0／`pane_id=1`。
- Symbol `TWSE_DLY:2233`、Timeframe `1D`。
- Account exact-name Strategy `obv-v3`、`script_id=USER;639b20c65fbb456cb769054b72623d40`。
- Initial Account version `1.0`、Pane `entity_id=jioZk7`、loaded version `1.0`、41 Inputs、Report ready。

Source comparison：

- Account raw source與local raw hash不同，原因是CRLF與LF。
- Normalize換行後，Account與`data/obv-v3.pine`皆為SHA-256 `5405a80b0702e289d821321383423d932639ae0862603ad91eacce9805bf714c`，內容完全相同。

Controlled update／refresh：

1. 在memory中對local source增加一行無功能影響的comment；未修改repo file。
2. Server compile通過且無warning；Account update由v1建立v2。
3. Readback確認existing `jioZk7`仍載入v1、status ready。
4. 保留v1並add same `script_id`, `version=last`，成功建立v2 `entity_id=p5ZsSA`。
5. v1／v2可同時存在；v2自動成為Active Strategy，兩者status ready。
6. 兩者41個Inputs ordered value hash皆為`bc94370e68f859e10c039349a23d6adc66d3d83b101adb8e13524c8b8ccc8f2a`。
7. 移除test v2，使用原始local source再update Account建立v3。
8. 保留v1並add latest v3，建立`entity_id=I0ESFd`；loaded version、Inputs及Report全部驗證成功後移除v1。

Final readback：

- Account latest version `3.0`，normalized source等於`data/obv-v3.pine`。
- Pane只有一個matching Instance：`I0ESFd`、loaded version `3.0`、visible、status ready。
- 41個Inputs與測試前相同。
- Symbol仍為`TWSE_DLY:2233`，Timeframe仍為`1D`。

Account version由1增加到3是本次明確授權測試造成且不可倒退；最终source與local file相同。Repo Pine file未修改。

## Input schema evolution

Pine source新增、移除、重新排序或改變Input type／constraints時，update前的dry-run必須先建立Candidate Input Schema並驗證全部Parameter Sets；詳細provider、comparison與post-update readback contract見[`PINE_INPUT_SCHEMA.md`](./PINE_INPUT_SCHEMA.md)。

- Parameter Set引用removed／renamed Input、type不相容、超出constraints或name ambiguous時，dry-run blocking error且不得update Account。
- 新增但未被Parameter Sets覆蓋的Input使用新版Pine default並產生warning，因為Parameter Sets是Base Inputs上的overrides而非完整schema副本。
- Input declaration重新排序不造成Config失效；Config以name解析，update後再映射至新版runtime `in_x`。
- New Pane Runtime Schema與dry-run Candidate Schema不一致時，移除本次建立的new Instance、保留old Instance並停止run。
