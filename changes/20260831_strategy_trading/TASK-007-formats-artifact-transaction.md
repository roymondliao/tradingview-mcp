---
id: TASK-007
title: Trading Data formats and artifact transaction
status: done
phase: strategy-trading
depends_on:
  - TASK-004
  - TASK-006
blocks:
  - TASK-008
scope: local
---

# TASK-007: Trading Data formats and artifact transaction

## Goal

提供canonical Strategy Trading Data的JSON／JSONL／CSV streaming encoders，以及安全的staging／atomic artifact transaction，並擴充`trading-data --output`。

## Requirements

### In scope

- 新增`strategy-trading-format.js`與`artifacts.js`。
- Default JSON、JSONL metadata-first records與Desktop-semantic CSV rows。
- Format／extension inference與conflict errors。
- UTF-8、newline、CSV quote/null與schema version。
- Streaming batch write，避免全部Trades常駐memory。
- Safe Symbol path、existing output guard、`--force`、staging與atomic publish。
- `strategy trading-data --format/--output`CLI integration與JSON stdout summary。

### Out of scope

- XLSX、remote storage或UI Download click。
- TradingView reads、reconciliation或Watchlist flow。
- File-to-file JSON reparse conversion。

### Constraints and references

- [`Format module`](./LLD.md#new-srccorestrategy-trading-formatjs)
- [`Artifact module`](./LLD.md#new-srccoreartifactsjs)
- TASK-004 canonical model與TASK-006 batch contract。

## Design

Encoders只接受canonical objects並實作start／writeBatch／finish／abort。Artifact transaction提供same-filesystem staging與rename；partial output永遠不使用final filename。

## Verification and Delivery

### Tests

- JSON／JSONL／CSV golden fixtures與跨format canonical parity。
- Unicode、quotes、comma、newline、null與Open Trade rows。
- Format inference、extension mismatch與unsupported format。
- Existing file、force、write failure、abort與atomic publish。
- Large multi-batch streaming memory behavior。

### Acceptance criteria

- [x] JSON為default且保留完整canonical envelope。
- [x] JSONL／CSV由canonical objects直接產生。
- [x] CSV涵蓋Desktop sample語意且不依locale headers。
- [x] Partial／failed write不留下成功final artifact。
- [x] CLI file output後stdout只回bounded JSON summary。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
```

### Deliverables

- Format encoders、artifact transaction、Trading Data output CLI、golden fixtures與tests/docs。

## Completion record

Completed on 2026-09-02.

- Added `src/core/strategy-trading-format.js`，提供`resolveTradingDataFormat()`與stateful streaming encoder interface：`start()`、`writeBatch()`、`finish()`、`abort()`。
- JSON以streaming array寫出完整lossless canonical batch envelope；JSONL固定依序輸出metadata、paired Trade records與summary；兩者皆直接使用canonical objects，不進行file-to-file reparse。
- CSV使用UTF-8 without BOM、comma、LF newline、RFC 4180 quoting與固定英文column schema；`null`輸出為empty unquoted field。Closed Trade輸出Exit／Entry rows，Open Trade輸出Mark／Entry rows，並保留Unix milliseconds及ISO companion。
- Added format resolution：default JSON、`.json`／`.jsonl`／`.csv`extension inference、case-insensitive explicit format、unsupported format與recognized extension conflict errors。
- Added `src/core/artifacts.js` single-file transaction：staging與final target位於同一directory；default以hard-link no-clobber publish，`--force`只在完整staging完成後rename替換final target。Write／publish failure會清理staging且保留既有final artifact。
- Added deterministic safe Symbol path segment與relative artifact path validation，供後續single-Symbol／Watchlist artifact tree重用。
- Expanded `strategy trading-data` with `--format`、`--output`／`-o`及`--force`。沒有output時stdout仍是JSON batch；file output完成後stdout只回傳不含`trades`的bounded JSON summary與path／format／bytes／row counts。
- Added golden canonical fixture及tests，涵蓋cross-format parity、Unicode、quotes、comma、embedded newline、null、Open Trade、format inference、conflicts、existing target、force replacement、write failure、abort、atomic publish與2,500-record multi-batch streaming。
- `fnm exec --using=22 npm run test:unit`：362 passed，0 failed。
- `fnm exec --using=22 npm run test:cli`：23 passed，0 failed。
- `fnm exec --using=22 npm run lint`：0 errors，3 pre-existing warnings。
- Desktop 3.4.0 compatibility：`layout_id`改由`_saveChartService.layoutId()`取得runtime／URL ID，再以`getSavedCharts().url`精確映射account `saved_layout_id`。三個Live Tabs均成功解析兩種ID，runtime與storage selector皆通過。
- Live `strategy trading-data --format csv --output`成功建立snapshot並atomic publish 513-byte CSV；stdout維持bounded summary，artifact含1筆paired Trade／2 rows與Unix millisecond／ISO timestamp。原Chart Symbol／Timeframe readback成功且無需restore mutation。
