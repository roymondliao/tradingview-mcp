# Desktop compatibility system design

Status: implemented. Latest scope decision: 2026-10-14, read-only contracts only.

## Boundary

相容性Gate確認目前Desktop仍提供shared Core依賴的必要CDP／Runtime能力、資源identity與資料契約。它不執行Tab／Pane切換、chart setters、Study/Input mutations、history loading、Script/Watchlist/Alert寫入、Editor編譯、Drawing lifecycle或Replay交易。這些屬E2E／回歸，不列Desktop report，也不是home passed前置。

CLI／MCP共用Core，provider只驗證一次；wrapper/schema/stdio/serializer屬專案測試，不另建立MCP Desktop Gate。

## Entry points

1. Launch scripts/shared Core launch先取得endpoint lease，記錄launch_pending，再啟動Desktop。
2. CDP ready的/json/version response由共用parser解析Desktop/Electron/Chromium/CDP；同版保留狀態，異版或checker identity改變使舊verification失效。
3. 普通Desktop CLI只讀home state，有效passed直接執行；其他狀態stderr warning後繼續原command，stdout／exit code不變。不查live version、PID、Git或source hash。
4. 使用者明確執行compatibility check才取lease、重新觀察版本並執行唯讀Gate。

沒有TTL或背景版本檢查。接受繞過launcher可留下舊observation的edge case；manual check會重新確認。

## Fixture and scope

Configuration位於[config/compatibility/fixture.json](../../config/compatibility/fixture.json)，由--fixture明確傳入。指定Layout／Pane、Indicator／Strategy entity IDs、Saved Pine ID、named Watchlist；不存在資源則blocked，不偷偷選其他Strategy或切換Pane。

可選exclude_checks目前僅允許PINE-001、GRAPHICS-001、DRAWING-001。使用者暫時排除這三組，runner不呼叫其handlers，report為not_applicable／USER_SCOPE_EXCLUDED並記錄設定來源，不算passed。六核心不可排除。

Registry revision2保留17checks／37唯讀assertions；目前30適用、7明確排除。原22個controlled assertions已移出registry，並非not_run、缺測或需要排除。

## Execution and concurrency

```text
explicit check
 -> validate options / fixture / output destination
 -> acquire endpoint execution lease
 -> live version + source fingerprint
 -> state checking + active_check + observation generation
 -> dependency-ordered read-only assertions
 -> final version/source/target/layout/pane/generation fencing
 -> aggregate + baseline + affected surfaces
 -> atomic publish report (+ requested output copy)
 -> fenced state update / verification
 -> disconnect checker client + release lease
```

單項讀取上限15s、整體120s。可重現readonly contract失敗可bounded retry一次；timeout／帳號或載入問題不直接推論不相容。取消後停止排程，保存interrupted／未執行結果；CDP取消context阻止late continuations發出後續操作。

Endpoint lock避免launch/manual checks互相打斷；短state transaction lock避免不同endpoint updates遺失。Heartbeat只代表lease ownership，不是版本cache TTL。只有可證明死亡的owner可接管；owner未知或guard損壞需人工恢復，不以時間過期強搶。

## State and promotion

State schema1：endpoints各自保存observed、status/reason、verification、last_check、active_check與generation。Local status是最近觀察與驗證的本地紀錄，不是Desktop即時health。

| Event | Home status |
| --- | --- |
| 無觀察／新identity | unchecked |
| Check執行／中斷未收尾 | checking（下一次明確操作恢復為blocked） |
| 所有適用唯讀contracts成立，report已出版 | passed |
| 必要contract失敗 | failed |
| 缺fixture／環境、未執行、中斷、checker/publication問題 | blocked |

Verification綁定exact environment identity、scope `read_only_desktop_contracts`、report path/hash、source fingerprint、checked_at及exclusions。Checker revision2使舊判定失效；不從歷史report自動重建passed。Excluded features與未測平台不因目前scope成功而認證。

Report先出版，state後更新；失去lease/generation、最終版本/source/context漂移、任何required blocked/not_run都不能寫有效passed。State write失敗保留report，但CLI結果失敗，local active_check仍阻止沿用舊passed。

## Report contract

Published schema3：

| Field | Content |
| --- | --- |
| checked_at / desktop_version / profile / scope | UTC完成時間、實際版本、read-only與contract範圍 |
| overall_status / compatible | 本輪結果與true/false/null |
| issues | Root failure優先；reason/action；失敗才有provider/expected/observed/version_relation與直接影響的CLI/MCP |
| checks | 全部check ID與單一status；成功不重複定義/evidence |
| coverage | total/passed/failed/blocked/not_run/not_applicable及complete |
| exclusions | 按check分組的明確scope排除、assertion IDs、設定來源 |
| changes | 可比baseline的新增失敗／恢復；無法比較則reason，不列所有unchanged IDs |
| environment / revisions / run_id / fixture_fingerprint | 精確平台／CDP／Node／repo/source與scope追溯 |

沒有controlled counts、restore/cleanup、mutation evidence或要求執行controlled的next_check。內部完整assertion records用於validation／aggregation，僅出版精簡文件；全report上限1MiB，不輸出tokens／cookie／完整Pine source／交易明細／runtime dump。

| overall_status | compatible | Meaning |
| --- | --- | --- |
| compatible | true | 所有適用唯讀契約成立 |
| incompatible | false | 已確立必要contract failure |
| environment_blocked / fixture_blocked / validation_blocked | null | 前提或coverage不足 |
| interrupted / checker_error | null（若另有確立contract failure可false） | 未完成可信驗證 |

`compatible`只描述此Gate契約範圍，不等同所有commands的操作E2E成功。缺fixture不等於不相容；沒有舊版證據不宣稱升版因果。

Baseline reader可讀歷史v1/v2與新v3的readonly結果；registry/profile/fixture/source不同時不可比。歷史報告不改寫，避免破壞已記錄hash。

## Verification

Deterministic tests驗證：17 IDs／37純唯讀handlers、DAG、surface inventory、局部缺測不得passed、排除不可假pass、前後identity/source漂移、atomic publication與state failure、local-only advisory，以及rejected controlled/options在network/state前結束。

操作與restore helpers只存在tests目錄，保留其fake-driver回歸coverage；本次沒有執行live mutation E2E。實際平台與版本證據見[Delivery evidence](./DELIVERY_EVIDENCE.md)。
