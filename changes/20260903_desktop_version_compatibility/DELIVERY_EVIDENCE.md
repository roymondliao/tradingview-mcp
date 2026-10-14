# Delivery evidence / support matrix

Latest decision and validation: 2026-10-14. **Compatibility certification is read-only Core/provider/data-contract validation. Controlled operations belong to project E2E and are not prerequisites.** Earlier notes below describe superseded designs/results.

## Current configured result

- Result: **compatible**, home **passed**, scope `read_only_desktop_contracts`.
- **30 assertions passed / 0 failed / 0 blocked / 0 not_run**; 7 explicitly excluded assertions across PINE-001 / GRAPHICS-001 / DRAWING-001.
- 17 checks: 14 passed, 3 user-scope excluded. Registry revision2 contains only37 read-only assertions; former22 controlled assertions are absent, not missing coverage.
- Report schema3, checker revision2, adapter revision1. Published report size: 3,136 bytes.
- Report: `2026-10-14T09-31-11-886Z-1c3c1f39-454a-4267-be63-b9045dd36a78.json`, completed UTC `2026-10-14T09:31:19.350Z`.
- `compatibility status` independently confirmed observed/verified Desktop3.4.1, statuspassed and verified_excluded_checks.

| Field | Current evidence |
| --- | --- |
| Desktop | `3.4.1` / `cdp_user_agent_tvdesktop` |
| Electron | `41.7.1` |
| Chromium / CDP | `146.0.7680.216` / `1.3` |
| Platform / architecture | `darwin` / `arm64` |
| Node / endpoint | `22.19.0` / `127.0.0.1:9222` |
| Base commit | `117aed8d50f3f8586718fcd7ce51a02e6de1b2e0` + uncommitted implementation |
| Source fingerprint | `b917c5af5fa2ccb86a793ea4b413994b43a81764e0ff70cf40b3ea659f1a69f8` |
| Fixture fingerprint | `4fc61099d0ddee7a939b0ae5df19a1f45061b50a8315a2e557d70ded596512f4` |

Configuration selects dev / Pane0, dev-testing-list, dev-test-indicator and active dev-test-strategy. No Desktop selection, source, account resources or chart state was mutated. Checker acquired/disconnected its own CDP client and wrote compatibility observations/report/state to home.

## Current delivery validation

- Node22 `test:unit`: **788 passed**, including compatibility and operation-helper regression coverage.
- Compatibility-focused suite: **68 passed**.
- Error-contract suite: **13 passed**.
- Lint: **0 errors**, 3 existing warnings; diff, JSON/config, document link and shell syntax checks passed.
- `--profile controlled` / operation Replay options are rejected before Desktop access; runtime Gate exports only read handlers.
- Operation/restore helpers and the operation fixture template now live under tests. Their fake-driver results are regression evidence, **not live mutation E2E success**.

## Current support scope

| Desktop / platform | Compatibility contracts | Operation E2E |
| --- | --- | --- |
| 3.4.1 / macOS arm64 | Current configured30 contracts passed; Editor/Graphics/Drawing excluded | Not executed live; separate project testing |
| Windows | Not validated live | Not validated live |
| Linux | Not validated live | Not validated live |

This result certifies the declared read-only contract scope, not all commands' effects or excluded/platform capabilities. Launch shell deterministic coverage is not real Windows/Linux certification. Complete required contracts, environment/source stability and atomic publication are still mandatory; missing fixture/incomplete/error results cannot promote.

## User manual acceptance — 2026-10-14

User confirmed the manual compatibility check succeeded. Latest home state independently reads passed for observed/verified Desktop3.4.1; latest report `2026-10-14T09-31-11-886Z-1c3c1f39-454a-4267-be63-b9045dd36a78.json` completed at `2026-10-14T09:31:19.350Z` UTC: 30 passed, 0 failed/blocked/not_run, 7 explicit exclusions, compatible true. This confirms current configured-scope manual acceptance; excluded Editor/Graphics/Drawing, other platforms and operation E2E are not included.

## Historical implementation notes (superseded where scope differs)

The records below preserve earlier evidence and design changes. Requirements for controlled/full-E2E promotion, diagnostics_passed-only outcomes, old schema/revisions and remaining controlled blockers **no longer apply to the current Gate**. Historical canonical reports remain unchanged.


Updated: 2026-10-13. Implementation completed; complete controlled Live certification remains blocked on fixtures.

## Reproducible environment

| Field | Observed value |
| --- | --- |
| Desktop | `3.4.1` (`cdp_user_agent_tvdesktop`) |
| Electron | `41.7.1` |
| Chromium / CDP | `146.0.7680.216` / `1.3` |
| OS / architecture | `darwin` / `arm64` |
| Node | `22.19.0` |
| Endpoint | `127.0.0.1:9222` |
| Base commit | `117aed8d50f3f8586718fcd7ce51a02e6de1b2e0` + uncommitted implementation |
| Source fingerprint | `ac09712740be543ecd461269fe213ebc3ca61a8fff0e9ec90ef85df14c1f747b` |
| Registry / checker / adapter revision | 1 / 1 / 1 |
| Report timestamp UTC | `2026-10-13T11:19:03.358Z` |
| Report file (under home compatibility/reports) | `2026-10-13T11-19-03-358Z-1cb28d1d-c428-4313-ace1-b2bd4b4180fb.json` |

The source fingerprint covers source, tests, launch scripts and package metadata; the base commit alone does not identify this implementation. Report timestamps are UTC. The local report path is returned by the CLI and recorded by `compatibility status`.

## Local verification

- Node 22 `npm run test:unit`: **780 passed, 0 failed**; includes the compatibility suite (60 tests), launch/routing, Core provider and regression coverage.
- `npm run test:errors`: **13 passed, 0 failed**.
- `npm run lint`: **0 errors**, 3 existing warnings in `src/core/data.js` and `src/tools/watchlist.js`.
- `git diff --check`, macOS/Linux `bash -n`: passed.
- Windows BAT/VBS and Linux launch integration have deterministic/source-level coverage; no real Windows/Linux Desktop launch was performed.
- New shell parent-helper lifecycle is tested with a child subprocess and temporary home. The live Desktop was not restarted for this delivery.
- `test:all` repeats the unit suite; state-mutating E2E/Replay tests were not run on the user's existing assets.

## Live read-only evidence

User-provided test resources: Layout `dev`, Watchlist `dev-testing-list`. The active Pane was index 0; only one Pane was available. Existing `obv-v3` Strategy and built-in Volume were used solely for reads. This does not authorize modifying those assets or make them disposable fixtures.

Result: **31 read assertions passed, 0 failed, 6 fixture-blocked**. All **22 controlled assertions were not run**. Six core components passed their read-only coverage. Account Pine inventory/source, Watchlist inventory/complete detail (100 symbols), and valid empty Alert inventory also passed. The checker did not open panels, change chart selection, edit source or mutate account assets.

Missing read fixtures:

- `PINE-001.read.editor_model`: Editor not open.
- `GRAPHICS-001.read.lines/labels/tables/boxes`: dedicated graphics fixture absent.
- `DRAWING-001.read.properties`: existing known Drawing fixture absent.

Overall `fixture_blocked`, `compatible: null`; home state updated to `blocked`. Restore was not attempted because this run was read-only. There is **no full passed certification**.

## Support matrix

| Desktop / platform | Read-only | Controlled / restore | Full support certification |
| --- | --- | --- | --- |
| 3.4.1 / macOS arm64 | 31 passed / 6 blocked | 22 not run; no mutation | Not certified |
| Windows | Not validated | Not validated | Not certified |
| Linux | Not validated | Not validated | Not certified |

## Remaining TASK-013 acceptance

Prepare the dedicated controlled fixture described in [RUNBOOK](./RUNBOOK.md): second test Chart Tab and Pane, mutable Strategy with valid Input and pagination/open/empty cases, graphics and Drawing fixtures, disposable saved Editor script, active mutable Watchlist, non-triggering Alert, entitlement evidence and separate opted-in Replay/Replay Trading fixture. User has supplied Layout/Watchlist names but no dedicated Strategy. Do not reuse the existing Strategy for mutation without explicit fixture designation.

Then run the complete applicable controlled Gate and verify restoration, cleanup, report publication and home promotion. Local fake-driver tests exercise success/failure/restore paths but do not substitute for this Desktop evidence. TASK-013 remains blocked until these conditions are met.

## Future support evidence template

Record exact Desktop/Electron/Chromium/CDP, platform/architecture, Node, commit plus source fingerprint, fixture fingerprint, registry/checker/adapter revisions, report reference, per-profile counts, exclusions with evidence, restore/cleanup outcomes and effective home state. For a breaking contract, attach assertion IDs, expected/observed, failure origin, environment/fixture causes excluded, baseline comparison or unknown, minimal reproduction and affected CLI/MCP surfaces. Do not add a version to the certified support matrix from a partial result.

## 2026-10-14 report presentation refinement

New reports use schema v2; state schema and compatibility/promotion rules remain unchanged. Passed assertion evidence, repeated registry definitions and large unverified-surface inventories are omitted. Issues are grouped by reason/evidence, root failures appear first, and actual failures retain expected/observed plus directly affected CLI/MCP names. Version and outcome are at the top.

The historical 2026-10-13 read-only report was converted solely for the format comparison: **77,204 → 3,994 bytes (95% smaller)**; six blocked assertions become three actionable issue groups. Historical canonical reports/home state were not rewritten, and no new Desktop probes or mutations were executed for this refinement.

Verification: Node22 unit **784 passed**, compatibility **64 passed**; final focused report/check tests **14 passed**, lint **0 errors / 3 existing warnings**, diff/link/JSON checks passed. Tests cover lossless assertion outcomes for baseline v1/v2, grouping, retained failure/exclusion/restore evidence, removed success noise, corrupt coverage rejection, and exact publication bytes/hash. Controlled Live certification remains blocked as above.

## 2026-10-14 fixture configuration location

Runtime fixture configuration moved from this Change's `examples/` to codebase [config/compatibility/](../../config/compatibility/README.md). The main `fixture.json` contains the supplied dev Layout/Pane 0/dev-testing-list; `fixture.controlled.example.json` is the complete preparation template. `--fixture` remains explicit and accepts any path; there is no automatic default selection. Configuration contents and Desktop state are unchanged. The report format example remains documentation under this Change.

## 2026-10-14 user-designated Indicator / Strategy verification

`config/compatibility/fixture.json` now selects the user-designated dev-test-indicator and dev-test-strategy, resolved uniquely from dev / Pane 0. The Strategy is active. Names, entity IDs, Saved Pine IDs and versions were recorded; no existing Study/source was edited. The same Indicator is selected for graphics reads.

Latest read-only report: `2026-10-14T08-29-36-424Z-737d48a3-8071-44c4-8dcd-7fad268868c7.json` (UTC `2026-10-14T08:29:45.946Z`). **32 passed / 0 failed / 5 blocked**; all six core components passed read-only coverage. **22 controlled assertions remain not_run**, home remains blocked; this is not full certification. Implementation fingerprint: `10507bccab9879dfea71843753dd291693ddd01dc295dc0f8b1b902a1b8c408e`; fixture fingerprint: `63b53e7f2228d507193f83f9bc9f28f6c7bfc95097d51a1e3a6b0163ca56b7bf`.

The current Indicator provides labels (5 observed). Missing fixtures are: open Pine Editor (1 assertion), visible lines/tables/boxes on the graphics fixture (3 assertions), and a known Drawing on dev Pane 0 (1 assertion; inventory currently empty). Dedicated test Strategy availability is now resolved; the earlier missing-Strategy notes describe the previous environment. Controlled configuration still needs the remaining target/pane, mutation, case, editor/account and Replay prerequisites described in the runbook.

## 2026-10-14 configured scope excludes Editor / Graphics / Drawing

At the user's request, the main fixture now explicitly excludes PINE-001, GRAPHICS-001 and DRAWING-001 through exclude_checks. Their handlers are not called, and the report groups them under USER_SCOPE_EXCLUDED rather than treating them as passed or unsupported. All registry definitions/handlers remain available. The six core groups cannot be excluded through this field.

Latest read-only report: `2026-10-14T08-55-41-212Z-9bf3d4f6-05a7-4d04-92b0-d1439f675364.json` at `2026-10-14T08:55:49.224Z` UTC. Result **diagnostics_passed**, **30 applicable read assertions passed / 0 failed / 0 blocked**; 7 read and 2 controlled assertions are explicitly outside scope. Remaining **20 controlled assertions not_run**. Home remains blocked from the earlier result because read-only success does not create or replace full verification; this latest report has no fixture blockers. This does not certify excluded features or complete controlled certification.

Source fingerprint: `499efe938c5ca5294216db41b679d5c1ef5475369ee14e7ff479960ac6890ea8`. Fixture fingerprint: `4fc61099d0ddee7a939b0ae5df19a1f45061b50a8315a2e557d70ded596512f4`. Local verification: **787 unit tests passed**, **67 compatibility tests passed**, lint **0 errors / 3 existing warnings**, diff/config/link checks passed. Tests confirm invalid/core exclusions fail before network/state operations, excluded handlers are not called or counted as passed, grouped baseline round trips retain outcomes, and controlled verification/status retain scope exclusions.
