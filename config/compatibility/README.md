# Compatibility configuration

`fixture.json` selects real resources for read-only Desktop compatibility checks:

- Layout `dev`, active Pane 0.
- Watchlist `dev-testing-list`.
- Indicator `dev-test-indicator` and active Strategy `dev-test-strategy`.

Names are descriptive metadata; Study reads use confirmed entity IDs. Update IDs after removing/re-adding a Study. The checker does not select another Pane or Strategy to satisfy a missing fixture.

```bash
tv compatibility check --fixture config/compatibility/fixture.json
```

Without globally installed `tv`, use `node src/cli/index.js`. Node >=22 is required. `--profile read-only` is optional; `controlled` is not a compatibility profile. `--fixture` explicitly selects a JSON file, accepts other paths and resolves relative paths from the working directory; no automatic loading/merging.

Root fields: schema_version, target, indicator, strategy, watchlist, graphics, drawing, exclude_checks. There are no operation/restore configuration requirements. Necessary providers, resource identity and data contracts passing is sufficient for compatibility certification and home passed.

## Optional scope

The current configuration explicitly excludes:

```json
"exclude_checks": ["PINE-001", "GRAPHICS-001", "DRAWING-001"]
```

Editor, graphics and Drawing handlers are not called. Reports record `not_applicable / USER_SCOPE_EXCLUDED` with configuration evidence, not pass or Desktop non-support. Remove an ID to re-enable that group. Only these three optional groups can be excluded; the six core groups remain required.

The full registry contains 37 read-only assertions; 30 apply to the current configuration. All applicable assertions passing, final environment/source stability and successful report/state publication produce passed for scope `read_only_desktop_contracts`. Status exposes verified_excluded_checks. A different configuration/scope cannot be compared as the same baseline.

Operation lifecycle/restore checks belong to project regression/E2E. Their test-only template is [desktop-operations.example.json](../../tests/fixtures/desktop-operations.example.json), not a compatibility input. Runtime observations, reports and locks remain under ~/.tradingview-mcp/compatibility/.

See the [runbook](../../changes/20260903_desktop_version_compatibility/RUNBOOK.md) for results, storage and troubleshooting.
