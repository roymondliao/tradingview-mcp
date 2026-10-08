---
id: TASK-004
title: Regression, Live Acceptance and Delivery
status: todo
phase: strategy-run-extension
depends_on:
  - TASK-003
scope: regression-and-delivery
---

# TASK-004: Regression, Live Acceptance and Delivery

## Goal

完成artifact compatibility、full regression、synthetic lineage capacity、controlled live Parent→Extension→Resume
acceptance、operator documentation及release evidence。

## Requirements

- Preserve explicit v2／v3 compatibility fixtures and add v4 fixtures。
- Update user manual、current artifact docs、CLI help and release notes。
- Add synthetic deep-lineage and large Parameter Set diff benchmark at all fixed bounds。
- Controlled live flow：
  1. Create Parent with baseline／candidate-check／rsi-check。
  2. Append at least 2 new Parameter Sets to same Config。
  3. Dry-run confirms 3 inherited + 2 new。
  4. Formal Extension executes only 2 new Experiments。
  5. Interrupt child and Resume it without rewriting Parent。
- Record Parent bounded metadata／inventory snapshots、write-spy evidence and child artifact counts。
- Use filesystem write spies plus bounded state/inventory snapshots；do not hash large Trade payloads solely to prove no Parent writes。
- Validate Node 22／24 CI-equivalent commands and package dry-run。

## Validation

- `npm run lint`
- `npm run test:unit` on Node 22 and 24
- `npm run test:durable`
- `npm pack --dry-run`
- `npm run release:check-version`
- `git diff --check`
- Controlled live evidence with bounded redacted outputs

## Acceptance criteria

- [ ] V2／v3／v4 compatibility matrix passes。
- [ ] Existing standalone Run／Resume behavior has no regression。
- [ ] Live child contains only new Experiment artifacts。
- [ ] Parent receives no filesystem writes and its bounded metadata／inventory snapshot is unchanged after all live scenarios。
- [ ] Child Resume succeeds without Parent runtime dependency。
- [ ] Tasks、decisions、release notes and delivery evidence are complete。
