---
id: TASK-008
title: Regression, Live Validation, and Delivery Gate
status: todo
phase: strategy-automation-run
depends_on:
  - TASK-001
  - TASK-002
  - TASK-003
  - TASK-004
  - TASK-005
  - TASK-006
  - TASK-007
blocks: []
scope: repository-delivery
---

# TASK-008: Regression, Live Validation, and Delivery Gate

## Goal

對Strategy Automation Run完成repository regression、controlled live acceptance、documentation與release-facing completion evidence；此Task只驗證已完成contract，不新增功能或以skip掩蓋failure。

## Requirements

### In scope

- Audit CLI help、Core exports、MCP parity ofextended atomic Pine／Study／Watchlist functions與error sanitization。
- Full lint／unit／CLI／repository regression。
- `dev` Layout、`dev-testing-list`、`TWSE:2330`與`data/obv-v3.pine`controlled dry-run／formal run；mutation前先完成exact-name fixture preflight。
- Same-source reuse與changed-source update／refresh代表案例。
- At least twoParameter Sets、fresh Report與complete Watchlist Snapshot evidence；正式full 448-symbol run是否執行由runtime成本與User確認決定，不能以未執行冒充通過。
- Final readback／restore、no residual test Instances與no local generated artifacts tracked。
- README／LLD／Task statuses、manual test guide與completion records。

### Out of scope

- 修復Desktop version compatibility change或新增Durable retry／resume。
- General-purposelocal E2E runner。
- Production Database import。

### References

- All TASK-001～007 acceptance criteria。
- [`docs/guildeline.md`](../../docs/guildeline.md)
- [`Strategy Trading manual test`](../../docs/strategy_trading_manual_test.md)

## Design

先執行deterministic regression，再做live preflight。Live mutation前保存exact target／Layout／Pane／script／entity／source／Inputs／Symbol／Timeframe；只操作User指定的`dev`／`obv-v3`fixture。任何phase在finally完成bounded cleanup與readback，Account version增加屬不可逆evidence需明確記錄。

## Verification and Delivery

### Tests

- All targeted Task tests與existing Strategy Trading／Watchlist／Study／Pine regressions。
- Dry-run no-mutation snapshots before／after。
- Invalid config：missing／duplicate names、removed Input與invalidParameter value。
- Valid same-source reuse run。
- Controlled source update／safe Pane refresh run。
- MultipleParameter Sets、Input restore與artifact parse/reconciliation audit。

### Acceptance criteria

- [ ] 所有TASK acceptance criteria均有deterministic evidence。
- [ ] Lint與完整repository tests通過，無新增warning／skip。
- [ ] Live dry-run沒有Account、Pane或filesystem mutation。
- [ ] Live formal run輸出可解析且身份、Snapshot、Inputs與reconciliation一致。
- [ ] Final Desktop state已read back；沒有測試建立的多餘Instances或staging artifacts。
- [ ] README task table、LLD、manual guide及completion records與實作一致。

### Validation commands

```bash
fnm exec --using=22 npm run lint
fnm exec --using=22 npm run test:unit
fnm exec --using=22 npm run test:cli
fnm exec --using=22 npm test
fnm exec --using=22 npm run tv -- strategy run --config ./run-config.json --dry-run
```

### Deliverables

- Regression results、bounded live evidence、updateddocs／tasks、release note input與clean working-tree audit。

## Completion record

Not started.
