---
id: TASK-008
title: Active Pane Study mutations
status: done
phase: study-strategy-cli
depends_on:
  - TASK-006
blocks:
  - TASK-009
  - TASK-011
scope: active-pane
---

# TASK-008: Active Pane Study mutations

## Goal

以共用 Study contract 提供 Inputs Get/Set、Visibility Toggle 與 Remove vertical slices，並保留既有 Indicator Commands 的相容入口。

## Requirements

### In scope

- `study inputs get <entity_id>`。
- `study inputs set <entity_id> --inputs '<json>'`。
- `study toggle <entity_id> --visible|--hidden`。
- `study remove <entity_id>`。
- 每個 Mutation 後 readback verification。
- Strategy Inputs／Visibility 更新後回報 Report recomputation state。
- `indicator get/set/toggle/remove` 呼叫相同 Core implementation。

### Out of scope

- 修改 Pine Source、Account Script 或其他 Pane。
- 將 Unknown Input Key 靜默視為成功。
- 以 Study Remove 刪除 Saved Pine Script。

### Constraints and references

- [`Inputs, Toggle and Remove design`](../../docs/study_strategy_cli_design.md#inputs)
- [`LLD mutation rules`](./LLD.md#mutation-and-destructive-operation-rules)
- Existing implementation: `src/core/indicators.js`

## Design

先由 TASK-006 read model 驗證 Active Pane ownership，再呼叫 shared mutation helper。Inputs Set 只修改已知 IDs，保存 before values 並讀回 after values；Remove 只在 after list 已不存在該 Entity 時成功。

## Verification and Delivery

### Tests

- Indicator／Strategy Inputs、Visibility 與 Remove success tests。
- Unknown input、unsupported input、wrong pane、unknown entity、timeout 與 readback mismatch tests。
- Legacy Indicator alias 與 Study command contract parity tests。

### Acceptance criteria

- [x] Strategy 與 Indicator 都能在不修改 Source 下更新 Inputs。
- [x] Response 區分 requested、applied、unchanged 與 unknown Input Keys。
- [x] Toggle 回傳 readback confirmed Visibility。
- [x] Remove 後 Entity 不再出現在 Active Pane List，Account Script 仍存在。
- [x] Legacy Indicator Commands 與 Study Commands 共用同一 Core behavior。

### Validation commands

```bash
npm run lint
npm run test:unit
npm run test:cli
npm run test:all
```

### Deliverables

- Study Inputs／Toggle／Remove Core、CLI、MCP、legacy aliases、readback verification、tests 與 migration documentation。

## Completion record

- Completed: 2026-08-21.
- Implementation: added shared Study Inputs Get/Set, Visibility Toggle and Active Pane Remove Core functions; added `study` CLI/MCP commands and routed legacy Indicator mutations through the same Core implementation.
- Verification: deterministic tests cover known／unknown Inputs, no-op values, visibility readback, removal readback failure and Active Pane ownership. Targeted Study／CLI／legacy tests passed; lint completed without errors.
- Safety: Remove verifies that the Entity disappeared from the Active Pane and never calls Account Saved Pine deletion. Live mutation smoke was skipped because TradingView Desktop CDP port `9222` was unavailable; no Pane mutation occurred.
