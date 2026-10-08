# Strategy Run Extension — Delivery Evidence

Status: automated gates passed; controlled TradingView Desktop live gate pending。

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
| `npm run release:check-version` | Version 1.3.1 synchronized |
| `npm pack --dry-run --cache /private/tmp/tradingview-mcp-npm-cache` | Passed; 263 files |
| `git diff --check` | Passed |

Targeted evidence includes：

- Prefix mutation and Pine source mismatch stop before runtime identity resolution。
- Same normalized Pine source at a different local path succeeds。
- A→B→C lineage order and fingerprints are verified；corrupt Parent fingerprint is rejected。
- Formal filesystem Extension creates only the new Experiment in a sibling child and leaves a Parent marker unchanged。
- V4 Extension child completes through `strategy resume` while its declared Parent directory is absent。
- Standalone Run and Extension both pass one `DurableRunExecutionSpec` to the shared lifecycle service。

## Pending controlled live gate

- Run one succeeded Parent with 3 Experiments on the dedicated TradingView test Pane。
- Append at least 2 Parameter Sets and confirm Extension dry-run reports 3 inherited + 2 new。
- Execute formal Extension and verify only 2 child Experiment directories。
- Interrupt and Resume the child with Parent unavailable。
- Record bounded Parent metadata／inventory snapshots and child artifact counts。
