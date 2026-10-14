# Desktop compatibility low-level design

Latest scope: 2026-10-14, read-only Desktop contracts. See [System Design](./SYSTEM_DESIGN.md).

## Modules

| Module | Responsibility |
| --- | --- |
| identity.js / version.js | Exact version parser、environment比對與scope常數 |
| io.js / lease.js / store.js | Bounded reads、atomic publication、endpoint/state locks與generation fencing |
| launch.js / advisory.js | Shared observation與local-only status/warning |
| fixture.js / registry.js | 唯讀fixture、允許的exclusions、17checks／37assertions／dependencies |
| runtime.js | 唯讀CDP／runtime資料契約handlers與pinned context guard |
| check.js | 唯讀runner、timeout/interrupt、環境fencing、report→state promotion |
| report.js / baseline.js / surfaces.js | Schema3、aggregation、歷史格式比較、CLI/MCP影響映射 |
| environment.js | Explicit check才讀取repo/source metadata |

`runtime-controlled.js`與`restore.js`不再是production Gate模組；操作helpers移到tests/compatibility/support/desktop-operations.js與restore.js。Production runtime只export read handlers。

## Revisions and identity

State schema1、report schema3、registry revision2、checker revision2、adapter revision1。Exact identity包含Desktop/Electron/Chromium/CDP、OS/architecture、Node major、checker/adapter revision。Version parser使用TVDesktop/TradingView token，不以Chrome version代替；衝突拒絕，缺Desktop token時manual --desktop-version才可補入並標記人工來源。

Observer bounded2s/64KiB，讀取失敗為environment blocked。普通CLI不呼叫observer或sourceFingerprint。

## Configuration

`--fixture config/compatibility/fixture.json`明確指定。Root fields：schema_version、target、indicator、strategy、watchlist、graphics、drawing、exclude_checks。Target為唯一Layout selector＋nonnegative pane_index。Study entity IDs與Saved Pine IDs必須屬於目前測試Pane；名稱僅作metadata。未提供時不自動尋找或改用其他資源。

exclude_checks限PINE-001／GRAPHICS-001／DRAWING-001，拒絕unknown/core/duplicate IDs。Validate在network／state writes之前執行。初始化整組assertions為not_applicable／USER_SCOPE_EXCLUDED，dependency loop直接跳過，不能執行handler後再隱藏結果。

第二個Tab/Pane、symbols/timeframes mutation、input_mutation、strategy_cases、alert write、editor compile及replay_target設定屬操作測試，不是compatibility configuration。操作範本位於tests/desktop/support/fixtures/operations.example.json。

## CLI contract

```bash
tv compatibility status
tv compatibility check --fixture config/compatibility/fixture.json
tv compatibility check --profile read-only --fixture /absolute/path/fixture.json
```

Options僅profile（只接受read-only）、fixture、desktop-version、output、force。`--profile controlled`與Replay操作flags拒絕，不能觸發操作。Core API亦在取得lease前拒絕舊操作options。

Status完全local-only，讀取missing／invalid也回傳bounded狀態；可顯示verified_excluded_checks。Check compatible為success/exit0；contract/fixture/validation/state failure為exit1，CDP kind為exit2，interrupt為130/143。CLI summary列overall_status/compatible、report_path、effective_status/state_update、check/assertion counts與可操作next_steps。

## Runner

1. Validate options/config/output；取得endpoint lease。
2. 保存initial live identity、sourceFingerprint與prior baseline；write generation/active_check/checking。
3. ENV assertions由observer填入；其餘依DAG執行純read handler。缺必要dependencies列blocked_by；缺handler列not_run，不能passed。
4. Read操作套用AsyncLocalStorage cancellation signal，單項15s、total120s；bounded retry只用於唯讀失敗。
5. 最後重新取得版本、source fingerprint、target/layout/pane並驗證generation與lease；漂移使ENV blocked。
6. finishReport＋validateReport；compactReport schema3；atomic publish canonical與要求的output副本。
7. 全適用readonly assertions passed才更新passed並建立verification；其他結果failed/blocked。最後disconnect checker client與release lease。

不執行restore、不記錄mutation journal，也不驗證操作E2E完成。

## Report and state

Internal results仍含expected/provider/observed與status，所有assertions必須stage=read-only。Publication拒絕非readonly assertions、duplicate IDs或無證據排除。Empty/partial/blocked/not_run不能eligible。

Schema3 checks為{id,status}，coverage為單一counts＋complete；issues合併同原因同evidence，failed保留必要形狀證據。Scope exclusions按check分組。沒有controlled counts、restore或next_check。Canonical與--output的bytes一致，state.report_sha256對應實際出版文件。

Verification.scope固定read_only_desktop_contracts；記錄environment identity、source fingerprint、report path/hash、exclusions與完成時間。有效passed需scope與當前implementation identity一致。Active_check存在時local effective status保守為checking。

Baseline v1只讀readonly assertions；v2讀readonly coverage並忽略歷史controlled IDs；v3讀單一coverage。核對known IDs/counts，不完整文件不可比；registry/source/fixture/profile不同先回not_comparable。舊report不改寫。

## Storage and failure handling

Home root固定os.homedir()/.tradingview-mcp/compatibility，跨cwd相同。State writes與report publication以temp/fsync/rename或exclusive publish完成；bounded schema invalid保留backup，不沿用其passed。

Output不得落在state root內，包含symlink canonical paths；既有額外副本須--force。Report先出版，state寫入失敗不假稱已登錄；superseded generation不覆蓋新observation。

Lease保存token/PID/process-start estimate/heartbeat。Only proven-dead owner可reclaim，不能只因wall-clock過期接管。普通command不做PID或lock recovery。

## Verification

Run test:compatibility、npm test、test:errors、lint與diff checks。Gate測試必須證明pure-read完整結果可promote、missing/drift/publish失敗不可promote、controlled/options拒絕且不連Desktop。Shared Core操作helpers保留獨立回歸，不納入Desktop report與passed條件。
