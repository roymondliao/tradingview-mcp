# Tests

Tests are grouped by module, then by type. The shared runner discovers test files recursively; new features do not need per-file entries in `package.json`.

```text
tests/
  compatibility/{unit,integration,support}/
  strategy/
    run/{unit,integration,support}/
    trading/{unit,support/fixtures}/
    parameters/unit/
    runtime/unit/
    unit/
    integration/
  cli/{unit,integration}/
  pine/{unit,integration,support/fixtures}/
  desktop/{e2e,support/fixtures}/
  test-runner/{unit,integration}/
  ...
```

## Feature testing

Run from the repository root with Node >=22; prefix commands with `fnm exec --using=22` when needed.

```bash
npm test                                           # All local unit + integration
npm run test:module -- compatibility                # One feature, all local types
npm run test:module -- strategy/run                 # A nested feature
npm run test:module -- strategy/trading
npm run test:unit -- --module chart                 # A narrower test type
npm run test:integration -- --module cli
npm run test:module -- chart data                   # Related features
npm run test:module -- strategy/run --pattern retry # Matching test names
npm run test:module -- compatibility --list         # List without executing
npm run test:e2e -- --list                          # Inspect the live selection
```

`strategy` includes all strategy submodules. Multiple/overlapping selectors run each file once. Unknown modules/suites, unclassified test files and empty selections fail explicitly.

## Types and environment

| Type | Purpose | Default local run |
| --- | --- | --- |
| `unit` | Focused logic/provider tests using injected dependencies or fake runtime; temporary files are allowed | Included |
| `integration` | CLI subprocesses, registration, multi-module orchestration and report/state pipelines | Included |
| `e2e` | Actual TradingView Desktop/session operations | Explicit only |

The full Desktop E2E suite remains under `desktop/e2e`; its shared session setup/restore has not been split into independent module suites. Fake-driver operation checks remain unit tests, not live E2E evidence.

Pine compiler integration and network-backed CLI cases retain explicit `TV_RUN_NETWORK_TESTS=1` opt-in and skip by default:

```bash
TV_RUN_NETWORK_TESTS=1 npm run test:module -- pine cli
```

## Stable commands

| Command | Selection |
| --- | --- |
| `npm test`, `npm run test:all` | All local unit + integration |
| `npm run test:unit` | All unit tests |
| `npm run test:integration` | All integration tests |
| `npm run test:compatibility` | Local compatibility module |
| `npm run test:cli` | Local CLI module |
| `npm run test:errors` | Local errors module |
| `npm run test:durable` | Local strategy/run subtree |
| `npm run test:verbose` | Local tests with the spec reporter |
| `npm run test:e2e` | Live Desktop E2E |
| `npm run test:e2e:replay` | Replay E2E with explicit opt-in |
| `npm run test:e2e:replay-trading` | Replay Trading E2E with both opt-ins |
| `npm run test:count` | Live E2E spec output, including final counts |

`test:unit` now means unit tests only. CI uses `npm test` to retain integration coverage. `test:all` means all local tests; live E2E remains explicit. Replay variables are set by the JavaScript runner, avoiding shell-specific assignment in npm scripts.

## Adding a feature

1. Add `tests/<module>/unit/<behavior>.test.js`; use `integration/` or `e2e/` for that scope. Nested modules such as `strategy/run` are supported.
2. Put helpers and fixtures in `tests/<module>/support/`. Support/fixtures/helpers directories are never executed, including fixture files ending in `.test.js`.
3. Use imports/fixture URLs relative to `import.meta.url`. The runner starts Node from the repository root, preserving repository-relative subprocess paths.
4. Run `npm run test:module -- <module>`. Include related modules when changing a shared contract; CI runs all local tests.

Do not import another `.test.js` to include it in a suite: independent discovery would duplicate cases. Share setup through `support/` modules.

The runner uses the current Node executable, explicit file arguments and forwards reporter/name-pattern options plus child exit codes/signals. Empty selections never fall back to unrestricted `node --test`.

## Migration verification (2026-10-14)

All 69 original test files and their support assets were relocated; Pine network compilation was separated from static analysis. The first local run preserved all 788 existing cases. With 8 runner tests added, `npm test` passes 796 cases. Discovery selects 54 unit files, 17 integration files and one explicit live E2E file. The compatibility alias passes 68 cases, and module selection also works from a different working directory. Live Desktop/network E2E was not executed during this reorganization.
