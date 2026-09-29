---
id: TASK-003
title: Symbol Retry Classifier and Atomic Attempt Export
status: todo
phase: strategy-durable-export-recovery
depends_on:
  - TASK-001
blocks:
  - TASK-004
scope: symbol-execution
---

# TASK-003: Symbol Retry Classifier and Atomic Attempt Export

## Goal

將現有verified Strategy Symbol export抽出artifact-writer seam，讓formal Run可把每次attempt完整寫入attempt-owned staging，再以固定classifier與3-attempt policy安全retry；legacy `strategy trading-export` behavior維持不變。

## Code ownership

### Add

- `src/core/strategy-run-retry.js`
- `tests/strategy_run_retry.test.js`
- `tests/strategy_symbol_attempt.test.js`

### Modify

- `src/core/strategy-trading.js`
- `src/core/index.js`
- `package.json`

### Reuse

- TASK-001 `strategy-run-artifacts.js` Symbol attempt store。
- Existing `executeFreshStrategySymbol()` Report／Data／Reconciliation flow。

## Requirements

### Artifact writer seam

- Refactor Symbol export I/O so runtime workflow writes through an injected writer interface。
- Durable writer outputs only`report.json`、`trades.<format>`、`reconciliation.json`inside current attempt staging。
- Legacy adapter continues mapping the same writes into`createArtifactSetTransaction()`for single-Symbol／Active Watchlist export。
- Runtime validation、pagination、snapshot matching、reconciliation and metadata must not be duplicated。
- `artifactInfo` returned to durable caller uses final canonical relative paths even before manifest commit。

### Retry constants

```js
STRATEGY_SYMBOL_MAX_ATTEMPTS = 3
STRATEGY_SYMBOL_RETRY_DELAYS_MS = [1000, 2000]
```

- Production values are frozen constants。
- NoConfig、CLI or environment override。
- Tests injectdelay／clock without sleeping。

### Error classifier

- Implement the exact`retry_symbol|fail_symbol|abort_run`table inLLD。
- Match stable `error.code` only；never read`error.retryable`。
- Unknown／missing code defaults to`abort_run`。
- `CDP_*`always aborts this invocation after connection layer has exhausted its own retry。

### Retry executor

- Accept callbacks for manifest transition、attempt begin／cleanup and one fresh execution。
- Before each attempt：check AbortSignal、cleanup uncommitted files、increment cumulative attempt count、commit`running`callback。
- Every retry invokes the full Symbol workflow from Report A and Trading Data offset 0。
- Retry failure with budget：abortstaging、commit`retry_wait`with sanitized error、performcancelable backoff。
- Exhaustion／`fail_symbol`：commit`failed`and return bounded failure；caller may continue next Symbol。
- `abort_run`：commit current Symbol 為 `failed`，再 throw。
- Successful artifact rename must happen before manifest success callback。
- Success callback failure leaves an uncommitted final folder and must not returnsuccess。

### Compatibility

- Existing single-Symbol and Active Watchlist tests retain V1 outputs、`partial`status and root atomic publish behavior。
- Existing Core errors may retain`retryable`; new durable artifacts exclude it。

## Tests

- Classifier table covers every declared code and unknown default。
- Success atlocal attempts 1、2、3 with expected delays。
- Retry exhaustion continues contract and cumulativeattempt count。
- Resume-style new executor invocation gets fresh local budget while using prior cumulative count。
- `fail_symbol`does not sleep；`abort_run`throws and no later attempt starts。
- AbortSignal beforeattempt and during backoff。
- Report／Trades／Reconciliation failure cleans onlycurrent staging。
- Crash afterrename but beforecallback fixture remainsnon-succeeded and rerunnable。
- Existing`strategy_trading_export.test.js`and`strategy_trading_watchlist.test.js`unchanged or only updated for internal injection seam。

## Acceptance criteria

- [ ] One runtime Symbol workflow serves bothlegacy anddurable writers。
- [ ] Retry policy cannot be modified byUser input。
- [ ] Every retry is a fresh complete snapshot workflow。
- [ ] No durable error record contains`retryable`or`retry_exhausted`。
- [ ] Artifact success is reported only afterdirectory commit and manifest callback。
- [ ] Legacy V1 exports have no observable regression。
- [ ] Targeted tests、full unit suite、lint and`git diff --check`pass。

## Completion record

Not started.
