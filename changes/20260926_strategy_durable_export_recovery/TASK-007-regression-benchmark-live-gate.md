---
id: TASK-007
title: Regression, Benchmark, and Live Delivery Gate
status: todo
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
- `docs/strategy_durable_export_recovery_manual_test.md`
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
- Updatefeature README to`done`only afterdeterministic andlive gates pass。

## Acceptance criteria

- [ ] Allfault windows have deterministic test ordocumented controlled live evidence。
- [ ] Node 22 unit／relevant all suites andlint pass。
- [ ] 652 × 3 benchmark evidence is recorded andD-014 becomes`accepted`withmeasured thresholds。
- [ ] Retry success、retry exhaustion、graceful interrupt、hard crash andDesktop restart Resume are verified。
- [ ] SameRun ID Resume skips allsucceeded Symbols。
- [ ] `stock_all_list`complete Snapshot count is652 andsingle-baseline Run reaches652／652 succeeded。
- [ ] Legacy formal dry-run、single-Symbol andActive Watchlist exports have no regression。
- [ ] Manual test document andallcompletion records are current。
- [ ] `git diff --check`passes andworking tree contains no generated output artifacts。

## Completion record

Not started.
