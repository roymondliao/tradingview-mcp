---
id: TASK-007
title: Regression, Benchmark, and Live Delivery Gate
status: in_progress
phase: strategy-durable-export-recovery
depends_on:
  - TASK-001
  - TASK-002
  - TASK-003
  - TASK-004
  - TASK-005
  - TASK-006
blocks:
  - feature-completion
scope: verification-and-delivery
---

# TASK-007: Regression, Benchmark, and Live Delivery Gate

## Goal

以deterministic fault matrix、652 × 3 filesystem benchmark、controlled TradingView retry／Resume tests與`stock_all_list`single-baseline endurance Run完成delivery evidence；此Task不新增未在LLD定義的feature。

## Code ownership

### Add or extend

- Durable recovery fault-injection test fixtures／helpers。
- Filesystem-only 652 × 3 benchmark test or script。
- `docs/strategy_automation_run_manual_test.md`
- This Change的completion records andD-014 measured thresholds。

### Modify as required

- `package.json`test scripts only when needed to expose deterministic suites。
- Existingtests only forfinal compatibility assertions。
- [`DECISIONS.md`](./DECISIONS.md)D-014 status／evidence。
- [`README.md`](./README.md)status／completion record。
- TASK completion records。

## Requirements

### Deterministic regression

- Run fullunit／all relevant suites onNode 22 andsupported current Node line used byCI。
- Explicitly cover everyLLD fault window：JSON write／flush／rename、Trade stream、Symbol directory rename、manifest callback、Run finalization、lease reclaim andsignal boundaries。
- Verify noattempt data mixing bydistinct snapshot／artifact markers。
- Verify succeeded Symbol isnever re-exported afterrestart。
- Verify corruption isrejected rather thanhidden byrerun。
- Verify legacy`strategy trading-export`V1 behavior andformal dry-run do not regress。

### 652 × 3 synthetic benchmark

- Use652 deterministic valid Symbols and3 Parameter Sets。
- Exercise manifest transitions、atomic replacements、attempt staging／rename、final audit andResume planning withoutDesktop。
- Record environment、Node version、filesystem、wall time、peak memory、bytes written、final manifest sizes andplanning latency。
- Run enough repetitions toavoid one-off measurement；documentmedian andworst observedvalues。
- SetD-014 thresholds from measured evidence withreasonable headroom, then make a deterministic gate that avoidsflaky hardware assumptions。
- Do not includeReport／Trades payload generation large enough tohide state-layer performance；measure payload separately if useful。

### Controlled live scenarios

Use dedicatedtest Layout／Pane／Strategy andsmall Watchlist：

1. A normal successfulRun。
2. One injected retryable Symbol failure that succeeds onattempt2 or3。
3. Retry exhaustion wherefollowing Symbol still executes andRun isfailed。
4. Process interruption after at least oneSymbol success, followed bysame-run Resume that does not rerun success。
5. Crash after Symbol directory rename but beforemanifest callback, followed bycleanup andrerun。
6. TradingView Desktop restart, volatile target/entity rebind andResume。
7. Stable identity drift rejection。
8. Duplicate Run／Pane process rejection。

Fault injection must useexplicit test seam or documentedmanual timing; production behavior cannot depend onhidden dev flag。

### Capacity live gate

- Resolve exact-name`stock_all_list`andverifycomplete stable Snapshot count is652，invalid0，duplicate0。
- Execute onebaseline Parameter Set over all652Symbols。
- If a transient failure remains after retry，Run may end failed；use explicit Resume to finish the same Run ID rather than a new Run。
- Final acceptance requiresall652manifest entries succeeded、artifact verification passes andRun status succeeded。
- Do not execute652 × 3 live；existing448 × 3 result remainsmulti-Parameter-Set evidence。

### Documentation and completion

- Manual test document includes commands、expected bounded responses、artifact checks、interrupt points、Resume commands andcleanup guidance。
- Recordrun IDs、snapshot IDs、counts、summary andsanitized failure codes；do not commitUser-specific absolute paths orlarge output artifacts。
- Update everyTask status／completion record only afterits acceptance passes。
- Update feature README to`done`only afterdeterministic andlive gates pass。

## Acceptance criteria

- [x] Allfault windows have deterministic test ordocumented controlled live evidence。
- [x] Node 22 unit／relevant all suites andlint pass。
- [x] 652 × 3 benchmark evidence is recorded and D-014 becomes `accepted` with measured thresholds。
- [ ] Retry success、retry exhaustion、graceful interrupt、hard crash and Desktop restart Resume are verified。
- [ ] SameRun ID Resume skips all succeeded Symbols in controlled live evidence。
- [ ] `stock_all_list`complete Snapshot count is 652 and single-baseline Run reaches 652／652 succeeded。
- [x] Legacy formal dry-run、single-Symbol andActive Watchlist exports have no regression。
- [x] Manual test document andallcompletion records are current。
- [x] `git diff --check`passes andworking tree contains no generated output artifacts。

## Completion record

Automated delivery phase完成，controlled live phase待執行：

- 新增`test:durable`，涵蓋Run/Resume state、atomic JSON／Symbol attempts、retry、leases、identity、signals、formal orchestration及dedicated fault matrix；Node 22與Node 24皆105 tests passed。
- Node 22與CI current Node 24完整unit suite皆642 tests passed；額外Node 26.5.1同樣642 tests passed。
- `npm run lint`為0 errors；只有既有`src/core/data.js`兩筆與`src/tools/watchlist.js`一筆unused-variable warnings。
- 新增filesystem-only`benchmark:strategy-durable`。Node 22.16.0／Darwin arm64／filesystem type 26／4096-byte block的三輪baseline：median 68,637.081 ms、worst 71,345.192 ms、peak RSS 107,593,728 bytes、logical writes 897,936,681 bytes、final disk 1,613,708 bytes、largest manifest 447,766 bytes、Resume audit+planning worst 4,531.916 ms、pure planning worst 8.598 ms。
- 固定D-014 thresholds後重新執行正式gate，`thresholds_enforced: true`；median 72,327.298 ms、worst 74,482.608 ms，1956/1956 Symbol executions於每輪皆成功且所有thresholds通過。
- 每個synthetic artifact使用Experiment／Symbol／artifact distinct markers並逐一audit，驗證attempt data沒有混用；所有temporary benchmark artifacts已自動清除。
- D-014已改為`accepted`；完整baseline、thresholds與headroom rationale記錄於`DECISIONS.md`。
- Durable recovery手測已整合到canonical `docs/strategy_automation_run_manual_test.md`，包含commands、bounded expectations、artifact checks、interrupt／crash points、same-run Resume、identity／lease scenarios、652 capacity gate及cleanup guidance。
- Existing multi-Parameter-Set evidence：2026-09-23 Run `obv-v3-20260923T092539Z-d87d94f0`，Snapshot `sha256:527cedc5ca74658fad8700b8bbd9e13e9f9920fb26595c72f6e1bfe5fd061b09`，3 Experiments × 448 Symbols，1344/1344 succeeded。這項只作為既有448 × 3 evidence，不取代artifact-v2 controlled live或652 single-baseline gate。

尚未完成且不可先標記done：controlled live retry／exhaustion、SIGINT／hard crash、rename-before-callback、Desktop restart rebind、stable drift、duplicate ownership，以及exact-name`stock_all_list` 652-Symbol single-baseline Run。Capacity Run必須先完成TASK-009並取得652/652 CDP Symbol validation evidence；完成並回填sanitized evidence後，才可將TASK與Feature改為`done`。
