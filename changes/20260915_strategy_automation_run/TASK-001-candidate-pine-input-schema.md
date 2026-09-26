---
id: TASK-001
title: Candidate Pine Input Schema
status: done
phase: strategy-automation-run
depends_on: []
blocks:
  - TASK-004
  - TASK-005
scope: pine-compiler-local-source
---

# TASK-001: Candidate Pine Input Schema

## Goal

擴充`pine check`保留TradingView compiler已確認的Input Variables，並以Minimal Local Declaration Scanner建立可供dry-run驗證Parameter Sets的Candidate Input Schema，不建立完整Pine Parser或執行Pine expressions。

## Requirements

### In scope

- Export Pine source newline normalization與normalized SHA-256 helper。
- Sanitize compiler`variables2`，只保留Input variable name與inferred type。
- Token-aware定位compiler已確認的`variable = input.<type>(...)`declarations。
- Static literal title、type、default／expression、group、constraints與options normalization。
- Generic balanced call／argument parser與versioned Input type registry。
- Candidate declaration／schema fingerprint。
- Compiler／scanner count、variable與type cross-check。
- Extend Core、CLI與現有`pine_check`MCP response；不輸出raw compiler payload。

### Out of scope

- Full Pine AST、interpreter或opaque compiled IL parser。
- Pane Runtime Input IDs。
- Parameter Set execution或Study mutation。
- Legacy無suffix`input()`support；V1回傳structured unsupported error。

### References

- [`Candidate Pine Input Schema`](./PINE_INPUT_SCHEMA.md)
- [`LLD module design`](./LLD.md#new-srccorepine-input-schemajs)
- Live fixture：`data/obv-v3.pine`，預期16個Input Variables／Candidate Inputs。

## Design

新增`src/core/pine-input-schema.js`pure module。Compiler adapter先產生Input variable whitelist；scanner只解析這些assignments，避免comments、strings或一般functions中的假matches。Static title是automation contract；無法可靠解析時阻止dry-run。

`input.time()`保留Pine type `time`與compiler/runtime value type `int`，不視為type mismatch。Source location只供diagnostic，不加入fingerprint。

## Verification and Delivery

### Tests

- CRLF／CR／LF normalization與hash parity。
- Compiler response sanitize、non-input filtering、missing／unexpected shape。
- Single／multi-line、nested calls、named／positional arguments。
- Strings／comments中的假`input.*()`。
- Static／missing／dynamic／duplicate title。
- Supported type registry、`input.time`type mapping與legacy unsupported。
- Literal／expression default及resolved／unresolved constraints。
- Candidate fingerprints與`data/obv-v3.pine`16-input golden case。
- CLI／MCP不洩漏raw compiler payload或private source。

### Acceptance criteria

- [x] `pine check`compile結果包含bounded Compiler Input Variables與available Candidate Schema。
- [x] `data/obv-v3.pine`輸出16個named Inputs，type與compiler results一致。
- [x] Scanner不需要理解Trading logic且不使用single-regex parser。
- [x] 無法確定title／constraint／type時回傳stable blocking error。
- [x] Existing compile errors／warnings與exit semantics保持相容。

### Validation commands

```bash
fnm exec --using=22 npm run lint
fnm exec --using=22 npm run test:unit
fnm exec --using=22 npm run test:cli
fnm exec --using=22 npm run tv -- pine check --file data/obv-v3.pine
```

### Deliverables

- Candidate schema module、compiler adapter extension、Core exports、CLI／MCP response、fixtures、tests與completion evidence。

## Completion record

Completed on 2026-09-16.

- Added`src/core/pine-input-schema.js`，提供CRLF／CR→LF normalization、normalized source SHA-256、sanitized Compiler Input Variables、token-aware／balanced-call scanner、bounded literal evaluation、type registry及versioned Candidate Schema／declaration fingerprints。
- Extended`pine check`Core／CLI／MCP shared response，保留compile errors／warnings並新增`input_metadata_available`、bounded`input_variables`與`input_schema`；raw compiler payload、private source與opaque fields不會進入response。
- Candidate Schema unavailable不改變既有compile success／failure語意；missing compiler metadata、compile failure、missing／dynamic／duplicate title、unsupported legacy`input()`、type mismatch、unresolved constraints與missing declaration均回傳stable bounded schema errors。
- Exported`pineInputSchema`Core namespace與normalized source helpers；Account Saved Script source readback重用相同newline normalization。
- Added`tests/pine_input_schema.test.js`並納入`test:unit`／`test:all`，涵蓋supported types、multiline／nested calls、comments／strings、literal／expression defaults、fingerprints、sanitization與`data/obv-v3.pine`golden case。
- Live TradingView Guest compiler：`data/obv-v3.pine`compiled with 0 errors／0 warnings；Compiler Input Variables 16、Candidate Inputs 16、unique static titles 16，schema fingerprint`320dfa20e7861ffd7b0da7cb6072150f7695ce22cd0d186e84e33590a9dc4122`。
- `fnm exec --using=22 npm run lint`：0 errors，3 pre-existing warnings。
- `fnm exec --using=22 npm run test:unit`：414 passed，0 failed。
- `fnm exec --using=22 npm run test:cli`：26 passed，0 failed。
- Targeted Pine／MCP registration suites：18 passed，0 failed；`git diff --check`passed。
- After TradingView CDP startup, default`npm test`and the sameE2E set withNode dot reporter completed successfully（exit 0）；Desktop health、Chart／Data／Pine surfaces and offline Pine tests passed。
