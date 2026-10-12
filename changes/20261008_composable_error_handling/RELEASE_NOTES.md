# Composable Error Handling — Release Notes

## Highlights

- Adds composable Source、Domain and Presentation error boundaries。
- Adds runtime kind、phase and stage semantics without changing formal Strategy artifact schemas。
- Prevents CDP failures from being mislabeled as Strategy identity mismatches。
- Distinguishes process interrupts from owner deadlines and other AbortSignal reasons。
- Uses one safe CLI／MCP diagnostic projection and deterministic process exit policy。
- Preserves unknown root-cause messages through CORE_UNCLASSIFIED_ERROR instead of inventing a domain failure。

## Compatibility

- Existing documented codes remain stable when their semantics are known。
- Strategy artifact v2／v3／v4 error records remain exact { code, phase, message }。
- failure_kind: cdp_connection remains as a migration compatibility field。
- Legacy missing-kind Core errors remain constructible before normalization；presentation requires normalized kind。
- Deferred modules are listed in ERROR_INVENTORY.md and continue through compatibility normalization。
