# Strategy Run Extension — Delivery Evidence

Status: complete for release `1.4.0`。

## Implemented

- Artifact v4 strict `standalone`／`extension` families with v2／v3 read and Resume compatibility。
- Bounded read-only Parent lineage loader、stable Parent／lineage fingerprints and A→B→C validation。
- Exact-prefix full Config comparison and Parent-Base new-only planning。
- Public `strategy extend --run-directory --config [--dry-run]` CLI。
- Shared `executePreparedDurableRun()` lifecycle used by standalone Run and Extension adapters。
- Self-contained Extension Resume with no Parent loader dependency。
- User manual、CLI examples and release notes updates。

## Automated validation

| Gate | Result |
| --- | --- |
| Node 22 `npm run test:unit` | 696 passed |
| Node 24 `npm run test:unit` | 696 passed |
| `npm run test:durable` | 130 passed |
| `npm run lint` | 0 errors; 3 pre-existing warnings outside changed files |
| `npm run release:check-version` | Version 1.4.0 synchronized |
| `npm pack --dry-run --cache /private/tmp/tradingview-mcp-npm-cache` | Passed; 272 files |
| `git diff --check` | Passed |

Targeted evidence includes：

- Prefix mutation and Pine source mismatch stop before runtime identity resolution。
- Same normalized Pine source at a different local path succeeds。
- A→B→C lineage order and fingerprints are verified；corrupt Parent fingerprint is rejected。
- Formal filesystem Extension creates only the new Experiment in a sibling child and leaves a Parent marker unchanged。
- V4 Extension child completes through `strategy resume` while its declared Parent directory is absent。
- Standalone Run and Extension both pass one `DurableRunExecutionSpec` to the shared lifecycle service。

## Controlled live evidence — 2026-10-08／09

The controlled TradingView Desktop flow used one 100-Symbol frozen Watchlist and the same Pine source/schema：

```text
Standalone A: obv-v3-20261007T031045Z-c79164b0
  3 Experiments
  └── Extension B: obv-v3-extension-20261008T143131Z-78e9f754
        + extend-check, 100/100 succeeded
        └── Extension C: obv-v3-extension-20261009T012334Z-4182723c
              + extend-check-2, 100/100 succeeded
              └── Extension D: obv-v3-extension-20261009T025102Z-edec730d
                    + extend-resume-check
```

Verified：

- B dry-run/formal reported 3 inherited + 1 new and created only `extend-check` artifacts。
- C reported 4 inherited + 1 new、`lineage_depth: 2` and created only `extend-check-2` artifacts。
- Both successful children contained 100 Symbol directories and 304 total files。
- D received one SIGINT after 11 succeeded Symbols；CLI returned exit 130 and persisted
  `RUN_INTERRUPTED` with 11 succeeded、1 failed and 88 pending。
- Child-only Resume planning selected exactly 89 indices (`11..99`) and skipped successful indices `0..10`。
- Direct Parent C was temporarily moved away before Resume；D completed to 100 succeeded with
  `resumed: true` and no Parent／lineage read error。
- The 11 pre-Resume succeeded entries retained identical attempt counts、timestamps and artifact paths。
- Parent C `run.json` and `watchlist.json` checksums remained unchanged。
- After Parent restore, bounded lineage validation succeeded for A→B→C→D at depth 3 with ordered sequence：

```text
baseline
candidate-check
rsi-check
extend-check
extend-check-2
extend-resume-check
```

This covers chained append-only planning、new-only execution、immutable Parent、graceful interruption、
self-contained Resume and post-restore lineage verification。
