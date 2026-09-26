---
id: TASK-008
title: Regression, Live Validation, and Delivery Gate
status: done
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

- [x] 所有TASK acceptance criteria均有deterministic evidence。
- [x] Lint與完整repository tests通過，無新增warning／skip。
- [x] Live dry-run沒有Account、Pane或filesystem mutation。
- [x] Bounded Live formal run輸出可解析且身份、Snapshot、Inputs與reconciliation一致。
- [x] Final Desktop state已read back；沒有測試建立的多餘Instances或staging artifacts。
- [x] README task table、LLD、manual guide及completion records與實作一致。
- [x] User完成`dev-testing-list`完整448-Symbol formal run手動驗收並回填結果。

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

Completed on 2026-09-24. Automated delivery gate completed on 2026-09-18；full-Watchlist manual acceptance使用TradingView Desktop 3.4.1（build 3.4.1.8194）於2026-09-23～24完成。

- `fnm exec --using=22 npm run lint`：0 errors；保留3個既有unused-variable warnings，沒有新增warning。
- `fnm exec --using=22 npm run test:unit`：524 passed；`npm run test:cli`：31 passed。
- `fnm exec --using=22 npm test`：連線本機Desktop CDP後88 passed、0 failed、0 cancelled、0 skipped；Replay仍是既有opt-in suite，沒有在Strategy gate啟用。
- Study／Strategy MCP registration、Named Watchlist Snapshot與sanitization targeted regression共124 passed。CLI help、Core namespace exports及atomic MCP parity均完成稽核；高階`strategy run`維持CLI-first，不新增重複的MCP orchestration tool。
- Live dry-run以exact names解析Layout`dev`／Pane 0／Saved Strategy`obv-v3`／Watchlist`dev-testing-list`；Account與Pane皆為version`3.0`、source hash相同，sync plan為`reuse`／`reuse`。Runtime Inputs 35、Candidate Inputs 16、schema diff為空，兩個Parameter Sets均通過。
- `dev-testing-list`完整Snapshot取得448 Symbols、stable reads 2、invalid／duplicate皆0，ordered fingerprint為`sha256:f05d6578c44a6e0c6375b84d6a7589d2714ac38668cdfde36d426dc4ce25caaf`。
- Bounded formal代表案例使用相同完整preflight後，僅以`TWSE:2330`子集執行`baseline`與`wobv-ma-11`兩組Parameter Sets；2份Report、2份CSV Trading Data與2份Reconciliation全部成功，reconciliation皆為true。實際mutation為`wOBV 平滑 MA 週期`10→11，Report fresh且stable reads 2；結束後11→10並以stable reads 2確認還原。
- Changed-source update／safe refresh使用TASK-005已保存的v1→v2→v3 live evidence；本Gate的same-source案例確認為reuse，沒有為重複驗證建立不必要的v4。
- Final readback與測試前一致：`layout_id=aQoXnpKX`、`saved_layout_id=201414175`、Pane`1`、Account／Pane version`3.0`、`entity_id=hdn44B`、35 Inputs fingerprint`d084bf5c1174577630a6be564cf7ed081c899f7c3bbfd2ba1a7b120e425fa219`、Symbol`TWSE_DLY:3645`、Timeframe`1D`。matching Instance仍為1；臨時artifact tree與staging均已清除。
- Full-Watchlist manual run使用`./temp/tv-strategy-run-positive.json`與output directory`./temp/output`。成功run ID為`obv-v3-20260923T092539Z-d87d94f0`，執行時間為2026-09-23T09:25:41.574Z～11:11:19.985Z；`baseline`、`candidate-check`與`rsi-check`三組Experiments皆完成448／448 Symbols，合計1344／1344成功、0失敗，terminal status為`succeeded`。
- Manual artifact audit確認三組Experiments各有448個Symbol directories及完整Report、CSV Trading Data與Reconciliation artifacts；1344份Reconciliation的總損益、勝率、總交易、獲利交易與虧損交易五項全部matched。Strategy source hash為`5405a80b0702e289d821321383423d932639ae0862603ad91eacce9805bf714c`，Candidate Schema fingerprint為`320dfa20e7861ffd7b0da7cb6072150f7695ce22cd0d186e84e33590a9dc4122`。
- Full run沿用完整`dev-testing-list`Snapshot ID`sha256:527cedc5ca74658fad8700b8bbd9e13e9f9920fb26595c72f6e1bfe5fd061b09`與ordered fingerprint`sha256:f05d6578c44a6e0c6375b84d6a7589d2714ac38668cdfde36d426dc4ce25caaf`；448 Symbols、stable reads 2且`complete: true`。
- `run.json`記錄`input_restore.success: true`與`restored: true`，35 Inputs恢復為Base fingerprint`d084bf5c1174577630a6be564cf7ed081c899f7c3bbfd2ba1a7b120e425fa219`。Final Desktop readback確認Account／Pane version`3.0`、`entity_id=hdn44B`、matching Instance為1，Chart恢復至該run開始時的Symbol`TPEX:5483`與Timeframe`1D`。
- 第一次Full-Watchlist嘗試`obv-v3-20260922T083336Z-eb70a85f`正確發布terminal`partial`artifacts：1342／1344成功；`baseline`的`TWSE:5388`及`rsi-check`的`TPEX:1815`在`chart_ready`發生retryable`SYMBOL_SWITCH_FAILED`，未留下被誤認為成功的partial Symbol artifacts。V1未手動拼接或resume，改用新run ID重新執行完整run。
- Collision acceptance以explicit既有run ID`obv-v3-20260923T092539Z-d87d94f0`於2026-09-24執行；preflight在任何Strategy mutation或artifact staging前回傳non-retryable`RUN_OUTPUT_EXISTS`，既有成功artifacts未被覆寫。
