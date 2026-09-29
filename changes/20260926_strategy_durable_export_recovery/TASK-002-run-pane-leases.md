---
id: TASK-002
title: Cross-process Run and Pane Leases
status: done
phase: strategy-durable-export-recovery
depends_on:
  - TASK-001
blocks:
  - TASK-005
  - TASK-006
scope: process-ownership
---

# TASK-002: Cross-process Run and Pane Leases

## Goal

在現有in-process`chartMutationMutex`外增加cross-process Run／Pane ownership，避免兩個CLI processes同時改寫同一Run或控制同一TradingView Pane，並提供可安全恢復crashed owner的stale lease protocol。

## Code ownership

### Add

- `src/core/strategy-run-lease.js`
- `tests/strategy_run_lease.test.js`

### Modify

- `src/core/index.js`
- `package.json`

### Do not modify in this task

- Run／Resume orchestration acquisition calls；由TASK-006整合。
- Existing `chartMutationMutex` behavior。
- CLI signal handlers。

## Requirements

### Stable keys

- Run key由canonical absolute Run Directory建立deterministic SHA-256；New Run需支援nearest existing ancestor realpath + validated missing segments，Resume使用既有directory realpath。
- Pane key優先使用`saved_layout_id + pane_id`；缺值時依LLD fallback到`layout_id + pane_index`。
- Key 不得包含 `target_id`、`tab_index` 或 current Symbol。
- Lock paths位於`os.tmpdir()/tradingview-mcp/strategy-leases`，不接受User自訂location。

### Acquisition

- 使用atomic non-recursive`mkdir`取得lease。
- Write bounded `owner.json`：schema version、random owner token、PID、process start timestamp、scope、run ID、stable key、acquired／heartbeat timestamps。
- Public helper固定依Run → Pane順序acquire，失敗時release已取得的earlier lease。
- Existing live owner立即回傳`RUN_ALREADY_ACTIVE`；不做unbounded waiting。
- Acquisition成功後回傳token-boundlease object與idempotent release。

### Liveness and reclaim

- Inject liveness checker for tests；production使用`process.kill(pid, 0)`。
- Success或`EPERM`視為live。
- 只有`ESRCH`可判定dead owner。
- Dead lock directory先atomic rename到tokenized quarantine，再由winner刪除並重新競爭mkdir。
- Corrupt／missing owner metadata不可只依mtime移除；安全拒絕並回傳bounded diagnostic。
- Heartbeat是diagnostic，不是單一reclaim條件。
- Release必須readback owner token；token不一致時不得刪除directory。

### Safety

- Reject symlink lease root／lock directory／owner file。
- Cleanup只能操作computed lease path和owned quarantine。
- Normalize PID／timestamps／keys before persistence，且owner metadata不得包含rawConfig或TradingView payload。

## Tests

- Same Run duplicate acquisition。
- Different Runs targeting same Pane。
- Different Panes can acquire concurrently。
- Dead PID reclaim race only produces one owner。
- Live PID and`EPERM`are not reclaimed。
- Corrupt owner metadata safely blocks。
- Token mismatch release preserves new owner。
- Partial acquisition releases Run lease when Pane lease fails。
- Heartbeat update and injected timer cleanup。
- Path／symlink safety。

## Acceptance criteria

- [x] Run and Pane keys are stable across Desktop target／entity ID changes。
- [x] Acquisition order cannot deadlock two callers。
- [x] No code path reclaims a lease based only onmtime／age。
- [x] Crash-owned leases can be reclaimed after positive dead-PID evidence。
- [x] Release never removes another process's lease。
- [x] Module has no TradingView／CDP dependency。
- [x] Targeted tests、full unit suite、lint and`git diff --check`pass。

## Completion record

Completed on 2026-09-29.

Implementation：

- Added `strategy-run-lease.js` with canonical future／existing Run path identities andstable Pane identities that exclude volatile target、tab、Symbol andentity fields。
- Added atomic OS-temp Run／Pane lease directories、bounded owner metadata、automatic diagnostic heartbeat、Run → Pane acquisition andPane → Run release。
- Added PID liveness handling where success／`EPERM`is live、only`ESRCH`is dead andallunknown／corrupt states fail closed。
- Added atomic stale-owner quarantine／reclaim andtoken-checked release，including serialization betweenin-flight heartbeat andrelease。

Validation：

- Node 22 targeted：18 tests passed。
- Node 24 targeted：18 tests passed。
- Node 22 full unit suite：575 tests passed，0 failed。
- ESLint：0 errors；repository仍有3個pre-existing unused-variable warnings outside thisTask。
- `git diff --check`passed。
