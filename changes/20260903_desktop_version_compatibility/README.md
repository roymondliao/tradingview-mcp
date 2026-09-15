# TradingView Desktop Version Compatibility Gate

Status: `planned`

## Objective

建立一套在 TradingView Desktop 升版後可重複執行的相容性驗證流程，確認本 repo 所有 Desktop-dependent CLI surfaces 依賴的必要 CDP、Runtime、resource identity、data、mutation／restore 與 output contracts 仍可運作。

若必要 contract 不再支援，Gate 必須先區分環境問題與 Desktop runtime breaking change，再以 bounded、去識別的方式調查新版替代能力，完成 Core adapter、deterministic regression tests、文件與 Live revalidation 後，才能宣告新版本受支援。

本 Change 由單一 [`TASK-001`](./TASK-001-desktop-version-compatibility-gate.md) 建立完整 Gate；後續若特定 Desktop 版本發生 breaking change，應另開 implementation task 或 follow-up Change，不在 Gate 中直接以未審核 workaround 掩蓋失敗。

## Trigger

以下任一條件成立時必須執行 Gate：

- TradingView Desktop 的 major、minor 或 patch version 改變。
- Electron／Chromium／CDP version 改變，且 Desktop version 無法可靠取得。
- 既有必要 Runtime API、DOM locator、response shape 或 lifecycle signal 開始失敗。
- 新增一個依賴 TradingView internal runtime 的公開 CLI capability。

每次結果必須綁定 Desktop version、OS／architecture、CDP Browser／Protocol version、Node.js version 與 repo commit；只寫「最新版可用」不算可重現的相容性證據。

## Definition of required information

「必要資訊」是目前受支援 CLI use case 為了定位資源、驗證 ownership、判斷完成狀態或產生正確資料而直接依賴的 observable contract。必要資訊不是要求 internal object 的所有 private fields 永遠相同。

- 驗證應優先檢查公開 CLI／Core response 與必要 capability，而不是硬比對完整 private object。
- Internal path 可以作為 capability provider evidence，但 implementation 應優先使用 capability detection。
- Nullable field 必須明確區分「合法 unavailable」與「必要資料遺失」。例如非帳號擁有的 Layout 可以沒有 `saved_layout_id`，但 Chart Tab 必須能解析 runtime `layout_id`。
- Localized label、使用者命名、CDP target ordering 與固定等待時間不可當成穩定 contract。
- Probe 不可輸出 cookies、tokens、完整 private Pine source、完整 unrestricted runtime object 或非必要帳號資料。

## Required test fixture

完整 Live Gate 應使用可識別且可恢復的測試環境：

- 至少一個帳號擁有的 Saved Layout，可由 runtime `layout_id` 映射到 `saved_layout_id`。
- 至少一個 Chart Pane，具有已知 Symbol、Timeframe 與 Pane identity。
- Pane 內至少一個 Indicator 與一個具有可讀 Report／Trades 的 Account Strategy。
- 一個至少包含兩個完整 `exchange:symbol` identity 的 Watchlist。
- 需要 mutation validation 時使用 disposable Pine Script／Study，並在 readback 後清理；不得修改或刪除使用者既有資產。
- 執行前記錄原 Tab、Layout、Pane、Symbol、Timeframe 與 Study state；任何受控 mutation 都必須 restore 並驗證 readback。

若 fixture 不符合條件，結果應標記為 `fixture_blocked`，不可誤判為 Desktop 不相容。

## Validation workflow

```text
Detect Desktop version change
  -> Record environment and known-good baseline
  -> Run read-only preflight and required capability checks
  -> Run controlled mutation / restore checks
  -> Run deterministic repository regression
      -> all required checks pass: certify supported version
      -> required check fails:
           -> classify environment / auth / fixture / runtime failure
           -> capture bounded sanitized evidence
           -> investigate replacement capability in the new version
           -> update shared Core adapter + old/new regression fixtures
           -> rerun the complete Gate
```

局部 command 再次成功不足以解除 failure；完成修正後必須重新執行完整 Gate，避免新版替代方式破壞其他 vertical slices。

## Required validation matrix

| Check | 必要資訊／行為 | 最低通過條件 |
| --- | --- | --- |
| `ENV-001` | Desktop、OS、architecture、Node、repo commit、CDP Browser／Protocol identity | Report 中存在可重現的 environment tuple；Desktop exact version 必須存在並記錄來源，自動偵測不可用時由明確 CLI input 補入，不可猜測。 |
| `SURFACE-001` | 所有依賴 Desktop 的公開 CLI commands 與 Core adapters inventory | 每個公開 surface 都映射至至少一個 required／entitlement-conditional check；未覆蓋項目會使認證失敗。 |
| `CDP-001` | `/json/version`、`/json/list`、WebSocket connect、Runtime evaluate、bounded timeout | CDP 可連線；timeout／disconnect 回傳結構化錯誤且 process 不永久等待。 |
| `TARGET-001` | Desktop shell、Chart targets、Active Tab resolution、reconnect | 多 Tab 不依賴 target list ordering；Active Chart 可唯一定位，切換後不沿用 stale client。 |
| `CONTEXT-001` | `target_id`、`url_chart_id`、runtime `layout_id`、optional `saved_layout_id`、`pane_index`、`pane_id` | `tab list` 與 Pane context 可解析相同 ownership；帳號 fixture 的 `getSavedCharts().url -> id` 映射成立。 |
| `CHART-001` | Symbol、resolved Symbol、Timeframe、chart-ready signal、mutation readback／restore | State 可讀；受控 Symbol／Timeframe 切換完成後可驗證並恢復，錯誤 identity 不可回報成功。 |
| `DATA-001` | Quote、OHLCV、indicator values、timestamp／numeric validity | 已知 fixture 可讀且 schema、ordering、Unix／ISO time contract 正確；無 `NaN`／Infinity 偽成功。 |
| `STUDY-001` | Study `entity_id`、type、source、visibility、inputs 與 active Strategy identity | Indicator／Strategy 可正確分類；精確 Entity read／mutation 不會落到其他 Pane 或 Entity。 |
| `STRATEGY-001` | Strategy status lifecycle、`reportData()`、metrics、Trades shape／counts／ordering、snapshot fields | Active Strategy、fresh Report 與 Trading Data 可取得；closed／open counts、oldest-first ordering與 snapshot consistency 通過。 |
| `HISTORY-001` | OHLCV fields、Unix timestamps／ISO companions、older-data request、dedupe／ordering／completion | 已知 Symbol 可取得有效 bars；向前載入有 progress／stop signal，結果不重複且時間遞增。 |
| `WATCHLIST-001` | Watchlist inventory、active Watchlist、完整 Symbol identity | List／Get 可讀且保留 `exchange:symbol`，不以 localized DOM text 作唯一判斷。 |
| `PINE-001` | Account Saved Pine inventory／source capability、editor state、compile／error readback | Read-only inventory 可用；受控 disposable script 可編譯並確認結果，且 cleanup 不影響既有 Scripts。 |
| `DRAWING-001` | Drawing inventory、stable selector、受控 create／get／remove readback | Disposable Drawing lifecycle 可完成並清理；不依賴 localized label 或不穩定 ordinal。 |
| `ALERT-001` | Alert service、inventory 與受控 create／delete readback | Test Alert lifecycle 可驗證並清理；使用者既有 Alerts 不被修改。 |
| `REPLAY-001` | Replay capability、state、受控 start／step／stop 與 restore | 在支援 Replay 的 fixture 上 lifecycle 與 stop readback 成功；不支援的 Symbol 明確歸類為 fixture／capability 條件。 |
| `UI-001` | Shell tabs、必要 panels、Pine editor 與 screenshot locators | Repo 使用的必要 locator 可唯一解析；不得以語言限定文字作唯一定位方式。 |
| `STREAM-001` | Quote／chart event subscription、bounded sample 與 unsubscribe | 可收到 bounded event sample，結束後完成 unsubscribe 且 process 正常退出。 |
| `OUTPUT-001` | JSON contract、bounded stdout、JSON／JSONL／CSV、atomic artifact publish | Live result 可被 serializer 處理；失敗不發布 partial final artifact，成功輸出可重新解析。 |
| `REGRESSION-001` | Unit、CLI、full regression、lint、diff check | 所有 required deterministic tests 通過；lint 無 error；沒有以永久 skip 取代必要 contract。 |

## Result states

- `compatible`：所有 required checks 通過，新 Desktop version 可加入 support matrix。
- `incompatible`：已排除環境、登入、fixture 與 entitlement 問題，至少一個 required runtime contract 確認缺失或改變。
- `environment_blocked`：Desktop exact version 無法確認、CDP 未啟動、未登入、網路／權限或 Desktop process 不可用。
- `fixture_blocked`：缺少測試 Layout、Strategy、Watchlist、歷史資料或 mutation fixture。
- `investigating`：已確認 version-related failure，正在尋找與驗證替代 capability；此狀態不可宣告支援。

Optional／deferred capability 失敗應記錄為 `unsupported_optional`，但不可用 optional 標籤降低現有公開 CLI contract 的必要性。

## Unsupported-contract investigation policy

當 required check 失敗時，依序執行：

1. 使用相同 repo commit 重跑一次，排除 transient calculation、stale target 或未完成載入。
2. 確認 environment、登入、entitlement 與 fixture prerequisites，分類是否真的為 version incompatibility。
3. 記錄失敗的 observable contract、最後已知可用 Desktop version、第一個失敗版本、error code／stage 與 bounded sanitized evidence。
4. 在新版只 probe 與失敗 contract 有關的 object paths、method availability、return types、必要 keys 與 lifecycle；禁止 unrestricted recursive dump。
5. 找出替代 provider 後至少驗證正常、缺失／錯誤與重複執行三種情境。
6. 優先在 shared Core adapter 加 capability detection 與 backward-compatible fallback；只有無可靠 capability discriminator 時才使用明確 Desktop version branch。
7. 新增舊版與新版 sanitized fixtures／tests，並更新 Terminology、runtime contract、support matrix 與 Change completion evidence。
8. 重新執行全部 required checks；不能只驗證原本失敗的單一 command。

若沒有可信替代能力，應保留 structured unsupported error 並將該 Desktop version 標記為 `incompatible`；不可用 UI timing、localized text、猜測第一個 Tab／Pane／Strategy 或舊資料 fallback 偽裝成功。

## Target report contract

預計提供 CLI-first 的 machine-readable Gate：

```bash
npm run tv -- compatibility check --profile read-only --output compatibility.json
npm run tv -- compatibility check --profile read-only --desktop-version 3.4.0 --output compatibility.json
npm run tv -- compatibility check --profile controlled --output compatibility.json
```

Report 至少包含：

```text
schema_version
started_at / completed_at
environment
desktop_version_source
profile
overall_status
checks[].id / required / status / duration_ms
checks[].observed_contract / error
restore
sanitization
```

`read-only` 用於升版後第一輪安全診斷；正式支援認證必須在專用 fixture 上完成 `controlled` profile 與完整 regression。`--output` 不得覆寫既有檔案，除非明確指定 `--force`。

## Tasks

| ID | Task | Status | Depends on |
| --- | --- | --- | --- |
| [TASK-001](./TASK-001-desktop-version-compatibility-gate.md) | Desktop version compatibility Gate | `todo` | — |

## Exit criteria

- Required validation matrix 已轉換成 versioned、machine-readable assertions。
- 所有依賴 Desktop runtime 的公開 CLI surfaces 都映射至 required 或有明確前置條件的 checks。
- Gate 能區分 `incompatible`、environment／fixture blocked 與 optional unsupported。
- Read-only profile 不改變 Desktop state；controlled profile 對所有 mutation 完成 restore readback。
- 任一 required check 失敗時不會輸出 `compatible`，並產生足以開始 bounded investigation 的安全 evidence。
- 新版 adapter 必須同時具有舊版與新版 regression coverage，且完整 Gate 重跑通過後才能加入 support matrix。
- 文件列出最後已驗證的 Desktop、Electron／Chromium／CDP 與 repo version tuple，不使用浮動的「latest」。

## Completion record

Not started.
