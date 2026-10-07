# Strategy Run Schema Naming — Release Notes

## Formal artifact v3

New `strategy run` executions now write explicit schema field names:

```json
{
  "artifact_schema_version": 3,
  "requested": {
    "config_schema_version": 1
  }
}
```

`experiment.json` and Experiment `manifest.json` also use
`artifact_schema_version: 3` at their roots.

## Compatibility

- Existing artifact v2 Run Directories remain resumable.
- V2 Resume updates preserve `schema_version: 2` and
  `requested.schema_version: 1`; no partial migration occurs.
- A Run Directory that mixes v2 and v3 formal artifacts is rejected before
  TradingView mutation.
- User-facing Run Config input remains schema v1 and continues to use
  `schema_version: 1`.
- Trading Export v1, Watchlist Symbol validation, Report, Trading Data,
  Snapshot and Reconciliation contracts are unchanged.
