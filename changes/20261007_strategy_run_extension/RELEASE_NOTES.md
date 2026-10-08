# Strategy Run Extension — Release Notes

## Added

- `tv strategy extend --run-directory <parent> --config <full-config> [--dry-run]`。
- Append-only exact-prefix Config comparison；only new suffix Experiments execute in a sibling child Run。
- Formal artifact v4 with `run_kind: standalone|extension` and strict Extension lineage metadata。
- Bounded A→B→…→N lineage traversal with cycle、fingerprint、depth、Experiment count and JSON byte checks。
- Self-contained Extension Resume；`strategy resume` never reads Parent or the original Config。

## Changed

- New standalone `strategy run` artifacts now use `artifact_schema_version: 4` and
  `run_kind: "standalone"`。
- Standalone Run and Extension formal execution share one durable lifecycle service。

## Compatibility

- Existing artifact v2 and v3 Runs remain readable and Resume preserves their original family。
- User-facing Run Config remains `schema_version: 1`。
- Legacy `strategy trading-export` artifact v1 is unchanged。
