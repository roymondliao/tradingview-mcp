---
id: TASK-003
title: Symbol Retry Classifier and Atomic Attempt Export
status: done
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

- [x] One runtime Symbol workflow serves bothlegacy anddurable writers。
- [x] Retry policy cannot be modified byUser input。
- [x] Every retry is a fresh complete snapshot workflow。
- [x] No durable error record contains`retryable`or`retry_exhausted`。
- [x] Artifact success is reported only afterdirectory commit and manifest callback。
- [x] Legacy V1 exports have no observable regression。
- [x] Targeted tests、full unit suite、lint and`git diff --check`pass。

## Completion record

Completed on 2026-09-29.

Implementation：

- Added `strategy-run-retry.js` with fixed3-attempt policy、stable code classifier、fresh invocation budgets、cumulative attempt counts andcancelable backoff。
- Refactored `strategy-trading.js` artifact I/O behind onewriter seam while retaining thesame Report A／Data offset0／Report B／reconciliation workflow。
- Added durable attempt writer mapping exactly`report.json`、oneTrades file and`reconciliation.json`; legacy transaction adapter remains unchanged forV1 exporters。
- Enforced directory commit beforemanifest success callback andcovered rename-before-callback recovery throughactual durable filesystem primitives。

Validation：

- Node 22 targeted compatibility set：48 tests passed。
- Node 24 targeted compatibility set：48 tests passed。
- Node 22 full unit suite：594 tests passed，0 failed。
- ESLint：0 errors；repository仍有3個pre-existing unused-variable warnings outside thisTask。
- `git diff --check`passed。
