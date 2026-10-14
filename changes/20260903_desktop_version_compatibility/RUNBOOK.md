# Desktop compatibility runbook

相容性Gate僅驗證必要唯讀contracts。操作／restore／E2E不是前置條件，也不需要第二個測試Tab/Pane、可修改Inputs、Alert price或Replay交易fixture。

## 執行

Node>=22；CDP預設127.0.0.1:9222，沿用TV_CDP_HOST／TV_CDP_PORT或CDP_HOST／CDP_PORT。

```bash
# 觀察版本（既有launcher也會做）
node src/cli/index.js launch

# Local-only，不連Desktop
node src/cli/index.js compatibility status

# 指定設定，執行純唯讀相容性Gate
node src/cli/index.js compatibility check --fixture config/compatibility/fixture.json
```

--profile read-only可保留；controlled與Replay操作flags已移除／拒絕。普通Desktop CLI只讀home state，未通過時warning後照常執行；沒有TTL或自動Gate。

## 目前設定

主設定[fixture.json](../../config/compatibility/fixture.json)包含dev Layout／Pane0、dev-testing-list、dev-test-indicator、dev-test-strategy。Strategy須保持active，Pane0須active，檢查時不要人工切換測試context；checker不替你切換。移除／重新加入Study後更新entity ID。

使用者明確排除Pine Editor／Pine graphics／Drawing（PINE-001／GRAPHICS-001／DRAWING-001）。不需要準備這三組fixture；它們標記USER_SCOPE_EXCLUDED，不算passed。移除exclude_checks中的ID即可重新納入。

目前registry17checks／37唯讀assertions，適用30、排除7。只要這30項全部成立，前後版本/context/source及report/state寫入正常，即可更新home passed。無需執行controlled或E2E。

## 結果

- compatible：目前設定範圍的必要readonly contracts全數成立，可更新passed。
- incompatible：必要contract可重現失敗；仍需看origin/version_relation，不直接宣稱Desktop升版造成。
- fixture_blocked／environment_blocked／validation_blocked：缺前提、timeout或未測，compatible為null。
- interrupted／checker_error：結果未完成或checker問題，不promote。

Report schema3先看desktop_version／overall_status，再看issues的reason/action。成功只留check status，coverage是單一counts，沒有controlled、restore或要求下一輪controlled的內容。Exclusions保留範圍證據；compatible不是所有操作E2E成功的保證。

Home state/report位於~/.tradingview-mcp/compatibility，跨cwd相同。--output產生額外副本，覆寫須--force且不能指向狀態目錄。CLI summary另列state_update；report出版成功不等於state更新成功。Failed/blocked summary沿用stderr/nonzero；success為stdout/exit0。

Local status的verified_excluded_checks顯示已驗證scope排除。Checker revision2與新scope使舊判定失效，重新執行即可；歷史報告不改寫。Baseline在registry/source/fixture/profile不同時不可比，不能假造版本因果。

## Locks與恢復

Endpoint lease避免launch/manual checks互相打斷；短state lock保護read-modify-write。普通command不取lease、不查PID。Heartbeat不是TTL；只有已證明死亡的owner可接管。若guard／ownership不明，確認程序已結束後人工處理，不直接強搶仍執行中的check。Active_check存在時local status保守顯示checking。

## 維護者驗證

```bash
fnm exec --using=22 npm run test:compatibility
fnm exec --using=22 npm test
fnm exec --using=22 npm run test:errors
fnm exec --using=22 npm run lint
git diff --check
bash -n scripts/launch_tv_debug_mac.sh scripts/launch_tv_debug_linux.sh
```

本地tests不列入Desktop report，也不是user check前置。npm test／test:all會自動搜尋所有本地unit＋integration；test:unit僅unit，完整compatibility suite可用test:compatibility。Operation/restore helpers保留於tests/compatibility/support，test fixture template位於tests/desktop/support/fixtures/operations.example.json；本次未執行live mutation E2E。

契約異常時保存完整version/environment/source tuple、report reference、failed assertion expected/observed、前提已排除原因、baseline或unknown，以及受影響surfaces。修正Core adapter後另外完成必要repo regression／E2E；不得以局部成功替代缺失的contract evidence。

當前版本、平台、檢測結果與限制見[Delivery evidence](./DELIVERY_EVIDENCE.md)。
