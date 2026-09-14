# Round 18 Few-shot TAS ローカルモック レビュー（追跡確認）

レビュー日: 2026-09-08<br>
対象: `fix/round18-review-followup` ブランチの未コミット実装（`git diff origin/main...HEAD`）<br>
前回レビュー: [2026-09-07_ROUND18_REVIEW.md](2026-09-07_ROUND18_REVIEW.md)（8件指摘）、対応記録: [FEWSHOT_IMPLEMENTATION.md#2026-09-08-レビュー指摘の修正完了](FEWSHOT_IMPLEMENTATION.md#2026-09-08-レビュー指摘の修正完了)

## 実施方法の注記

当初は並列サブエージェントでのコードレビューを試みたが、セッション制限により正しさ・不変条件を検証する系統のエージェント（line-by-line diff scan、cross-file tracer、removed-behavior auditor）が失敗した。完走したのは効率性・再利用性の観点のみ（今回の依頼範囲外）だったため、指定された8項目と不変条件は本レビュー担当が直接コード・テスト・diffを読んで検証した。ファイルは変更していない。

## 確認した範囲

- `2026-09-08_HANDOFF.md`、`docs/2026-09-07_ROUND18_REVIEW.md`、`docs/2026-09-06_FEWSHOT_SPEC.md`（該当節）、`docs/FEWSHOT_OPERATIONS.md`、`docs/PRODUCTION_CONNECTIVITY_GUIDE.html`、`docs/FEWSHOT_IMPLEMENTATION.md`
- `git diff origin/main...HEAD` 全体（76ファイル）、特に `.gitignore`、`tools/prepare-connectivity-inputs.mjs`、`public/{app,fewshot,run-observer,segments}.js`、`public/index.html`、`src/{pipeline,cleanup}.js`、`test/{fewshot,connectivity-inputs,run-observer}.test.js`

## 前回8指摘への対応確認（すべて実装と記述の整合を確認）

1. **実接続ガイド完走** — `PRODUCTION_CONNECTIVITY_GUIDE.html` 手順6のボタン名（「語彙・識別条件を登録」「確認済みとして登録」「標準セットを生成」「生成した標準記述・不足申告を確認」「内容を確認して公開」「解析を開始」）は `public/index.html:69-73`・`public/fewshot.js:136,144,148-149` と一致。`demoInputButton`（サンプルを設定）は `fewshot.js:141` `$('#demoInputButton').hidden=config.mode!=='mock'` で実接続モードでは非表示。`tools/prepare-connectivity-inputs.mjs` はモデル呼び出し0で合成MP4登録とGT/語彙のみ生成し、`video_id` が一致するGTを出力（`connectivity-inputs.test.js` で検証済み）。
2. **Git除外** — `.gitignore` に `/data-real/`・`/connectivity-inputs/` 追加済み（diff確認）。
3. **未反映入力の保全** — `public/app.js:350-355` の `applyPendingDetail()` が `selectSegment`/`nudgeHandle`/`beginHandleDrag`/`deleteSegment`/`openAddDialog`/`undo`/`redo`/`switchView`（各所に `if (!applyPendingDetail()) return;`）で呼ばれ、未反映時は検証・反映してから遷移する。不正時刻は `segments.js:5,23` の `timeToSeconds`/`validateSegments` で検出され、`editWorsened`（`segments.js:65-67`）が真なら `saveDetail` が `false` を返し、`renderDetail`（`app.js:349`）は `formDirty` の間early returnして入力を保持する。`persistReview`/`download`（`fewshot.js:100-101`）も `applyPendingDetail()` を先に呼ぶ。`renderDirty`（`app.js:391`）で「区間に未反映」「履歴に未保存」「変更なし」を区別表示する。
4. **通信失敗後の再開・古いrun抑制** — `public/run-observer.js` は4/8/16/30秒でバックオフしつつ無限に再試行を継続（`test/run-observer.test.js` で `[4000,8000,16000,30000,2000,2000]` を確認）。`generation` カウンタと `isCurrent()` により、切替後に遅着した旧runの応答は `observeOnce`（`fewshot.js:62-64`）内で `if(!isCurrent())return false;` により画面へ反映されない（`switching runs suppresses delayed responses` テストで確認）。
5. **人が追加した区間の語彙選択** — `openAddDialog` → `workflow.prepareAdd()` → `labelSelector($('#addForm'))`（`fewshot.js:17,156`）で追加ダイアログにも確認済み語彙のselectを設定する。サーバー側 `src/pipeline.js:294` `demand(label,'INVALID_REVIEW',...)` で語彙外job_no/job_titleを拒否する（`test/fewshot.test.js` の `free-text` 拒否テストで確認）。
6. **確認済みJSONの単独追跡性** — `src/pipeline.js:297` の `review` オブジェクトが `original_result:source`（AI原本全体）を同梱し、`original_result_sha256`・`segments`・`changes`・`editor`・`created_at` を含む。`store.immutable` で新規ファイルとして保存し、既存result.jsonや旧reviewを書き換えない（`test/fewshot.test.js` で `assert.deepEqual(await service.result(...), result)` により原本不変を確認）。
7. **品質警告の分離表示** — `fewshot.js:104`（`#globalWarnings`＝`MISSING_PROCESS`のみ、動画全体向け）と `fewshot.js:18`（`warnings()`＝区間別、`ORDER_REVERSAL`等の具体文言）で分離。判定ロジック（`segments.js` の `qualityWarningsV1`）自体は変更せず、表示のみの分離。
8. **成功・終了条件と画面表示の一致** — `src/cleanup.js:48` `summary()` は該当runにcleanup ledgerエントリが無ければ`not_needed`（「対象なし」）、それ以外は状態に応じ`deleted`（「削除完了」）等。ガイド手順7・8の文言と `CLEANUP` マップ（`fewshot.js:5`）が一致。

## 不変条件の確認

- **GT隔離**: `test/fewshot.test.js` の送信本文チェックで `build_only_gt`/`gt_process_id`/`display_segments` が非guided Stage1本文や zero_shot Stage2本文に含まれないことを確認。
- **原本と修正履歴の分離・原本不変**: 上記6と同テストで確認。
- **Stage1共有（案1/3のみ、案2は分離）**: `test/fewshot.test.js` で案1/3のartifact_idが一致し案2は別（`results.slice(0,4)` の `Set.size===1`、案2は別artifact）を確認。
- **Stage2時刻不変・中止後の確定防止**: `src/pipeline.js:277` 等で `demand(!current.cancel_requested&&!this.controller.signal.aborted,'CANCELLED',...)` をpersisting直前に確認。
- **実接続失敗のモック置換禁止**: `src/pipeline.js:19` でモデルアダプタは起動時に `MockModelAdapter`/`GeapAdapter` のいずれかに固定され、実行時フォールバック経路は存在しない。

## 指摘

重大度「高」「中」に該当する指摘は見つからなかった。直接確認した範囲では、前回レビューの8指摘・不変条件のいずれにも矛盾する実装は確認できなかった。

強いて挙げるなら軽微な観察（修正不要、参考情報）:

- `public/app.js:347` の入力却下パス（`editWorsened`成立時）は `render()` を呼ばず `return false` するのみだが、`state.reviewed` は編集前に完全復元され、`renderDetail` も `formDirty` 中はearly returnするため実害はない（低優先度・任意）。

## 今回のレビューで扱わなかった観点

並列サブエージェントのうち効率性・再利用性（efficiency/reuse/simplification）の観点は完走したが、今回のユーザー依頼（正しさ・不変条件の確認）の範囲外のため本書には含めていない。必要であれば別途まとめる。

## 実測が必要な事項（前回から変更なし）

このレビューはローカルモックと、実APIへ接続するためのコード・文書を確認したものである。次の事項は、実データ・認証・権限・評価計画がそろった別の検証で判断する必要がある。

- Gemini / GEAP APIが実際の設定で接続・応答できるか
- モデルのラベル精度、似た工程の見分け、安全網の見逃し率
- 18〜22分程度の動画での処理時間と安定性
- 実際の使用量と費用
- Cloud Storageの権限、アップロード、削除、障害時回収が実環境で成立するか

`npm.cmd test` 39/39成功、`npm.cmd run probe:self-test` LOCAL_TESTS_PASSED は合成データでのローカル検証結果であり、上記の実測完了を意味しない。3方式とも実運用の適格性は引き続き `unverified` である。
