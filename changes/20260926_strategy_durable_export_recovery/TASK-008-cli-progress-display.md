---
id: TASK-008
title: Strategy Run and Resume CLI Progress Display
status: done
phase: strategy-durable-export-recovery
depends_on:
  - TASK-006
blocks:
  - feature-completion
scope: cli-progress-presentation
---

# TASK-008: Strategy Run and Resume CLI Progress Display

## Goal

為長時間執行的formal `strategy run`與`strategy resume`提供TTY-only單行進度顯示，讓User可即時得知本次invocation已處理比例、目前Experiment及成功／失敗數量，同時保持既有stdout final JSON contract、artifact contract與execution correctness不變。

## Display contract

進度列只顯示以下資訊：

1. 百分比與`processed / total`。
2. 目前Experiment，格式固定為`Experiment <index>/<count>: <name>`。
3. `succeeded`數量。
4. `failed`數量。

範例：

```text
[██████████████░░░░░░] 68.4%  892/1304 processed | Experiment 2/3: candidate-check | succeeded 891 | failed 1
```

不顯示目前Symbol、完整Watchlist、attempt history、error message、Trades或其他unbounded內容。

## Progress semantics

### Invocation denominator

- `strategy run`的`total`為本次Run選取的所有Parameter Sets × frozen Watchlist Symbols。
- `strategy resume`的`total`只計算Resume planner本次選取的non-succeeded Symbols。
- Resume開始前已是`succeeded`的Symbols不納入本次denominator，且不得被重新執行。
- 若Resume selection為空，既有`RUN_ALREADY_SUCCEEDED`或validation behavior維持，不建立0/0進度列。

### Processed counter

- `processed = succeeded + failed`，三者皆為本次invocation counters。
- Symbol artifacts已atomic publish且manifest callback成功保存`succeeded`後，才增加`succeeded`及`processed`。
- Symbol在本次invocation耗盡fixed retry budget，manifest成功保存`failed`後，增加`failed`及`processed`。
- Retry的`running`與`retry_wait`transitions不增加`processed`；同一Symbol最多只貢獻一次terminal processed count。
- `skipped`表示未完成處理，不加入`processed`。
- Fatal error發生前若目前Symbol已durably transition為`failed`，可計入processed；尚未執行或只進入`running`／`retry_wait`的Symbols不計入。
- 進度達100%只代表本次選取的工作均已處理；當`failed > 0`時Run仍可回傳`status: failed`。

### Experiment identity

- `Experiment <index>/<count>`使用original persisted Parameter Set order與總數，不因Resume只選部分Experiments而重新編號。
- 例如只Resume原始第2個Experiment時，仍顯示`Experiment 2/3: candidate-check`，不可改成`Experiment 1/1`。
- Experiment名稱來自persisted plan，不從UI文字或artifact folder反向推測。
- 切換Experiment時立即刷新名稱；Symbol retry期間維持相同Experiment顯示。

## Output and terminal behavior

- Progress只寫入`stderr`，final bounded JSON只寫入`stdout`。
- 只有`stderr.isTTY === true`時自動顯示；non-TTY、pipe、redirect、MCP及programmatic Core呼叫不輸出progress。
- 不新增Run Config欄位、environment flag或必要CLI option。
- 使用carriage return原地更新單行；Run完成、failed、signal abort或exception離開時寫入一次newline，避免final shell prompt黏在progress line後方。
- Terminal寬度不足時可縮短bar本體，但不得省略百分比、processed、Experiment、succeeded或failed。
- 百分比顯示一位小數，並限制在`0.0%`～`100.0%`。
- Progress renderer failure不得使Strategy Run／Resume失敗；presentation不參與execution correctness。

## Architecture

### Core progress event seam

Core不得直接讀寫`process.stderr`。Run與Resume共用的durable execution path提供optional bounded callback，例如：

```js
on_progress({
  processed,
  total,
  succeeded,
  failed,
  experiment: {
    index,
    count,
    name,
  },
})
```

- Event只在authoritative manifest transition成功persist後發出。
- Event payload不得包含Symbol list、artifact payload、errors或runtime object references。
- Callback absence必須維持目前behavior與performance。
- Callback error由presentation boundary隔離，不得回滾manifest或中止Run。
- 不以polling或重讀整份manifest產生進度；應沿用durable execution已知的selection與post-persist transition。

### CLI renderer

- CLI signal wrapper建立renderer並將callback傳入`runStrategyAutomation()`／`resumeStrategyAutomation()`。
- Renderer負責TTY detection、format、carriage return、newline及dependency injection tests。
- Router仍只負責final JSON與exit code；不得把progress events混入JSON response。
- Existing CLI help、exit codes 0／1／2／130／143及sanitization維持不變。

## Code ownership

### Add

- `src/cli/progress.js`或等價的pure formatter／TTY renderer module。
- Progress formatter、renderer、Run及Resume integration tests。

### Modify as required

- `src/core/strategy-durable-experiment.js`：在terminal manifest transition persisted後提供bounded progress seam。
- `src/core/strategy-resume.js`：建立invocation selection totals並轉送original Experiment identity。
- `src/core/strategy-run.js`：formal Run轉送progress callback；dry-run不建立renderer。
- `src/cli/commands/strategy.js`：只為formal Run／Resume建立TTY renderer並確保finalize newline。
- `tests/strategy_durable_experiment.test.js`、`tests/strategy_run.test.js`、`tests/cli.test.js`及TASK completion records。
- `docs/strategy_automation_run_manual_test.md`：加入TTY與redirect smoke checks。

## Requirements

### Formatting

- Exact information order：percentage／processed → Experiment → succeeded／failed。
- Example labels保持`processed`、`Experiment`、`succeeded`、`failed`，方便manual test與log辨識。
- Bar可以使用Unicode block characters；若terminal capability或測試環境不適合，必須有ASCII-safe fallback而不改變資訊內容。
- Experiment name必須bounded並清除control characters，避免terminal injection或多行輸出。

### Run behavior

- Initial event顯示`0/total processed`與第一個即將執行的Experiment。
- 每個terminal Symbol結果只更新一次。
- Retry success只在最終success後增加一次succeeded。
- Retry exhaustion增加一次failed後繼續下一Symbol，進度不得停住或重複計數。
- 全部Symbols處理完但含failure時可顯示100%，final JSON仍為`success: false`／`status: failed`。

### Resume behavior

- Denominator使用locked post-lease Resume plan，避免TOCTOU造成total錯誤。
- 已成功Symbols不得出現在denominator、processed events或execution calls。
- Resume若涵蓋original Experiment 2與3，顯示仍為`2/3`、`3/3`。
- 每次Resume invocation重新從`0/<selected>`計算presentation counters；artifact中的cumulative `attempt_count`不影響processed。

### Compatibility

- `strategy run --dry-run`完全read-only且不顯示progress。
- Legacy `strategy trading-export`不加入此progress contract。
- Non-TTY stdout/stderr behavior與目前版本一致。
- Final JSON shape不因progress而新增unbounded fields；是否保存terminal summary仍由既有Run artifacts與response contract決定。

## Tests

### Pure formatter／renderer

- 0%、中間值及100% formatting。
- Narrow terminal與Experiment name sanitization／truncation。
- TTY更新使用單行carriage return；finish／error／signal只補一個newline。
- Non-TTY不寫入；writer error不影響caller。

### Execution semantics

- First-attempt success：processed與succeeded各增加一次。
- Attempt 2／3 success：retry transitions不增加，最終只增加一次。
- Retry exhaustion：processed與failed各增加一次，下一Symbol繼續更新。
- Fatal abort：只計算已durably terminal的Symbols。
- Run可在100%時仍`status: failed`。
- Callback在manifest persistence failure時不得發出成功進度。

### Resume

- Locked plan只含non-succeeded Symbols，denominator正確。
- Succeeded Symbols不重跑且不計入本次progress。
- Original Experiment index／count保持，例如`Experiment 2/3: candidate-check`。
- Same Run ID與artifact state不因renderer有無而改變。

### CLI compatibility

- Progress只出現在TTY stderr fixture。
- Captured stdout仍是單一可parse的final JSON。
- Redirect／pipe fixture沒有ANSI或carriage return progress。
- SIGINT／SIGTERM、normal failure及thrown error後terminal line正確結束，exit codes不變。

## Acceptance criteria

- [x] Formal `strategy run`與`strategy resume`在TTY顯示單行progress。
- [x] 顯示內容僅包含百分比／processed、Experiment、succeeded／failed。
- [x] Retry不重複計數；retry exhaustion算processed failed並繼續。
- [x] Resume denominator只包含locked plan中的non-succeeded Symbols。
- [x] Original Experiment index／count／name顯示正確。
- [x] Progress在manifest terminal transition persisted後才更新。
- [x] Progress可以100%但final Run仍因failed Symbols失敗。
- [x] Progress只寫stderr；stdout final JSON與non-TTY behavior不回歸。
- [x] Dry-run與legacy `strategy trading-export`不顯示此progress。
- [x] Node 22／24 targeted與full unit suites、lint及`git diff --check`通過。
- [x] Manual TTY、redirect、retry exhaustion與Resume smoke tests通過。

## Completion record

Completed on 2026-09-30.

- 新增failure-isolated TTY renderer；使用carriage return更新單行，normal／failure／signal／exception結束時只補一個newline，non-TTY完全不寫入。
- 顯示順序固定為percentage／processed、original Experiment identity、succeeded／failed；terminal較窄時先縮短bar及Experiment name，不省略必要labels。
- Run與Resume共用durable execution progress seam。Initial event由locked invocation selection計算total；terminal counters只在`manifest.json`的`succeeded`／`failed`transition成功persist後更新。
- Retry的`running`／`retry_wait`不計數；attempt 2／3 success只算一次。Retry exhaustion與fatal error已durably保存failed時各算一次，未執行Symbols不計入。
- Resume denominator只包含locked post-lease plan選取的non-succeeded Symbols；只Resume原始Experiment 2/3時仍顯示`Experiment 2/3`。
- CLI只為formal `strategy run`與`strategy resume`建立renderer；dry-run、legacy exporter、MCP及programmatic Core在沒有callback時不輸出progress。
- Targeted CLI／Experiment／Run／Resume suites：63 tests passed。Node 22與Node 24完整unit suites各661/661 passed；lint為0 errors（保留3筆既有warnings），`git diff --check`通過。
- Controlled PTY smoke確認0%／66.7%／100%原地更新、100%仍可搭配failed final JSON，且JSON從新行開始；non-TTY smoke只輸出JSON，沒有carriage-return progress。
