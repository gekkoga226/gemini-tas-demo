# Round 18 実装記録

開始: 2026-09-07 / 基準: `2026-09-06_FEWSHOT_SPEC.md` Round 18。

## 着手順の例外と保全

利用者の2026-09-07の明示指示により、12.9の実測完了前にモック・接続コード・プローブを実装する。ゲートは実接続の運用成立・精度合格を判断する条件として維持する。3方式の実測適格性はすべて **unverified**。合成データのテスト成功をCheckの実測PASSへ読み替えない。

開始時の適用AGENTS.md: ルートの祖先およびリポジトリ内に該当ファイルなし。Git開始状態: `.gitignore` 変更、Few-shot仕様・2レビュー、`docs/ui-proposal/`、`tools/` 未追跡。利用者資産として保全。指定6ファイル全文、server/src/public/test/package/docs/SPECを確認。凍結プロンプトSHA-256: `06bfefc4e758e54bf8b4b54714fa727e4be68cc6176bf529402fce69a9ba8db5`。

開始時テスト: `node --test` 18/18成功。Node、FFmpeg/ffprobeあり、gcloudはPATH上に無し。実動画・同意・project・bucket・モデルIDは未確認。実API送信は未実施。

## D1〜D10 対応表

| ID | 実装先 | 検証 | 状態／残課題 |
|---|---|---|---|
| D1 | src/pipeline.js、public/fewshot.js、標準公開 | fewshot/assets：セット承認、6条件 | 実装・ローカル検証済み |
| D2 | src/inputs.js、キャッシュ/移行 | fewshot/failure-paths：案1/3同一実体、guided指定拒否 | 実装・ローカル検証済み |
| D3 | buildStage2、src/geap.js、src/cleanup.js | 0/1動画、画像/お手本条件、401/403/429/5xx | 実装済み／実API未実施 |
| D4 | src/contracts.js、ID結合 | Stage2時刻追加拒否、小数秒不変、失敗原本なし | 実装・ローカル検証済み |
| D5 | src/inputs.js、プローブrequest監査 | 全送信本文の動画本数、GT項目不混入 | 実装・ローカル検証済み |
| D6 | Observation、4種Stage1派生プロンプト、標準profile | 固定/発見、共有Observation、標準/実作業の自己申告 | 実装・ローカル検証済み |
| D7 | build-inputs、exampleView、Zero/Few | GT拒否、6条件入力差、Check 7匿名境界 | 実装・ローカル検証済み |
| D8 | src/store/pipeline/media/cleanup.js、履歴UI | 永続化、切断、中断、再起動、原子的保存、削除失敗/猶予/session、明示移行 | 実装・ローカル検証済み |
| D9 | public/segments.js、saveStage2、修正履歴 | .92→.49とraw保持、分母0、Undo/Redo、原本保全、安全網のみ再計算 | 実装・ローカル検証済み |
| D10 | tools/geap-probe/extra-checks.mjs、scoring.mjs、self-check.mjs | 手計算、合成51条件レコード/3反復、APIなし再採点 | 実装・ローカル検証済み／全実測ゲートunverified |

## 作業順と再開点

1. 契約・プロンプト・入力・保存・媒体・接続・ジョブを実装。
2. 既存画面の配色/タイムラインを継承し、上下比較・履歴・修正/出力へ接続。
3. プローブ・評価算法・ローカル故障検証。
4. 全テスト、ブラウザ主要操作、運用文書、差分と凍結ハッシュ確認。

構造変更が必要になれば理由・影響・代替案をここへ追記する。コミット・push・公開・デプロイは行わない。

## 再開用スナップショット（2026-09-07）

- アプリ本体、派生プロンプト、契約、永続ジョブ、媒体/削除、PDF語彙確認、代表画像、Stage1共有/移行、安全網再計算、上下表示、修正履歴を実装。
- Check 7〜11を合成データで通し、保存・採点・3反復内共有・反復間新規生成を検証。既存Check 0〜6は残し、追加プローブはPart直下/v1beta1固定。Check 2は参考のまま。
- 最終全テスト記録 `.local-validation/final-tests.txt` を回収：34/34成功、失敗・中止・スキップ0、19.738秒（Node v24.11.1、外部APIなし）。コード変更がないため全テストの重複実行は行っていない。旧テストの「real API」は注入した通信での旧疎通契約テストであり、実測ではない。
- 再開前の確認済み範囲（最新HANDOFFから引継ぎ）：サンプル作成・標準公開、全6条件、合成MP4アップロード、候補・raw .92 / 表示 .49、編集・Undo/Redo・修正保存、履歴復元、両JSON出力、処理中再読み込み、上下区間同期・独立再生。
- 再開後の最終確認（2026-09-07 21:02〜21:04 JST）：最新コードでサーバーを再起動。前回中断した案3 Zero-shotを履歴から再試行して成功。さらに21:03:17の再判定を画面で中止し、「中断／利用者が中断しました。」を確認。履歴の再試行から21:03:31の実行が完了し、5区間・候補根拠・上下タイムラインが表示された。Stage1 `e1459596-7c6b-44b8-ad4a-52b62d2899a2` と共有元を維持し、中断履歴も残った。一時媒体は削除完了、費用は不明表示、ブラウザコンソールの警告・エラー0件。
- 最終差分確認：`git diff --check` 成功。凍結プロンプトのSHA-256は開始時と一致し、Git差分なし。今回の再開でアプリコードや利用者資産は変更していない。モックの残検証と記録更新は完了。実API・精度・性能・費用は未実測のまま。
- 起動中の検証サーバー：127.0.0.1:4173、MOCK_MODE=true。実データ送信なし。

## 変更ファイル一覧

引継ぎとGit差分に基づく今回実装の一覧。未追跡ファイル全体を新規生成物とは扱わない。

| 分類 | ファイル |
|---|---|
| 起動・永続処理 | `server.js`、`src/{routes,pipeline,contracts,response-schemas,core,store,cleanup,settings,geap,media,cost,inputs,mock-model}.js` |
| 画面 | `public/{index.html,styles.css,app.js,fewshot.js,segments.js}` |
| プロンプト・評価 | `prompts/*.md`、`prompts/round18.v1.json`、`tools/prepare-prompt-manifest.mjs`、`tools/geap-probe/{probe,extra-checks,scoring,cleanup,self-check}.mjs` |
| テスト | `test/{fewshot,scoring,geap-adapter,failure-paths,assets,evaluation,cost}.test.js`、`test-support/fixture.js` |
| 設定・文書 | `package.json`、`.gitignore`、`README.md`、`tools/geap-probe/README.md`、`docs/{FEWSHOT_OPERATIONS,FEWSHOT_IMPLEMENTATION,SPEC,DESIGN,IMPLEMENTATION_RESULT}.md` |

今回の再開時の編集は本実装記録と `2026-09-07_HANDOFF.md` の完了記録のみ。ローカル検証履歴はGit除外の保存領域に追加された。コミット・push・外部公開・デプロイなし。

## 実装判断・修正した不具合

- D1〜D10の構造変更なし。仕様12.9に対する着手順のみ利用者承認の例外。性能・費用・精度の閾値を発明しない。
- Windowsで読み込みとrenameが競合する場合、原子的置換を保ったまま短く再試行。公開途中のディレクトリだけが見える一覧走査は未公開ファイルを除外。
- 中断対象runを追跡し、別runのcontrollerを止めない。queued/awaiting_approvalの明示中断も終了状態にする。
- 代表画像の要求時刻はナノ秒桁で正規化して浮動小数点の1フレーム遅れを防ぐ。実抽出PTSは丸めず保存する。
- 生の標準不足判定は採用根拠に参照したexampleから算出。候補にあるだけの標準不足は採用根拠と混同しない。
- 旧Flash同期APIは互換テスト用として残し、通常の実接続起動では旧経路を410にする。画面からは新しい永続ジョブだけを呼ぶ。
- 古い仕様・設計・実装記録には履歴であることと現行版の参照を追記。凍結プロンプト、過去レビュー、ui-proposalは保全。


## 2026-09-08 レビュー指摘の修正完了

レビュー7日版の8件を修正した。既存の未コミット実装・文書は保全し、コミット・push・デプロイは行っていない。

| 指摘 | 修正・検証 |
|---|---|
| 1 実接続ガイドのサンプル操作 | 合成MP4のローカル登録と、動画IDが一致するGT・語彙・識別条件を出力する `tools/prepare-connectivity-inputs.mjs` を追加。空の保存先から人の語彙登録→標準セット生成・公開→Few/Zeroへ進む手順に修正。モデル結果のコピーなし。入力準備はモデル呼出し0、後続の完走はモックで検証。実接続成功とは扱わない。 |
| 2 data-realのGit除外 | `/data-real/` と `/connectivity-inputs/` を除外。動画・requests・responses・GTの代表パスで `git check-ignore` を確認。独自DATA_ROOTはリポジトリ外を案内。 |
| 3 未反映入力の喪失 | formDirtyを分離し、未反映／履歴未保存を表示。区間切替・タブ切替・編集操作の前、履歴保存・確認済みJSON出力時に入力を検証・反映。不正入力は保持。保存中の追加入力も未保存状態を維持。ブラウザで入力→切替、直接保存、再読込、不正時刻の保持、直接JSON出力を確認。 |
| 4 通信失敗後の更新停止 | `public/run-observer.js` で上限30秒の再接続と実行切替時の古い応答抑制。サーバー状態と画面の接続表示を分離。完了後の回収確認にも適用。4連続失敗から復帰・回収継続・旧応答・404のテストを追加。 |
| 5 追加区間の自由入力 | 人の追加区間でも早期return前に語彙選択欄を設定。タイトルとページを連動しAI候補は生成しない。追加後の再編集・JSON出力をブラウザ確認、サーバーの語彙外拒否も検証。 |
| 6 確認済みJSON | 新規履歴に `original_result` を加算し、AI原本全体を同梱。修正区間・変更差分・確認者・日時・原本ハッシュと区別。原本不変と同梱ハッシュ一致をテスト。旧履歴は不変のまま、旧ファイルは原本と組で保管。 |
| 7 品質警告 | 判定規則は変えず、順序逆転などの具体的な警告を対象区間へ表示。工程抜けはタイムライン上の動画全体の確認事項へ。推論原本の警告と明示。JSON根拠は折りたたむ。ブラウザで両方の確認文を検証。 |
| 8 成功・終了条件 | 各runで削除完了、送信なしなら対象なしを終了条件とする。接続先は画面上部、実行時点の条件はAI予測JSONで確認する手順へ修正。 |

最終 `npm.cmd test`: **39/39成功、失敗0**（`.local-validation/review-tests-final.txt`）。`npm.cmd run probe:self-test`: **LOCAL_TESTS_PASSED**、外部API呼出し0、実Check 0〜11はNOT_RUN。報告は `tools/geap-probe/runs/e5f81db5-d7b6-4561-bc7f-80efed2edc68/local-acceptance.json`。ブラウザでモック作成・公開・分析、上記編集操作と画面、接続ガイド手順6の表示を確認した。

GT隔離、Stage1案1/3共有・案2分離、Stage2時刻不変、中止後の確定防止、原本と履歴の分離、実接続失敗をモック成功に変えない経路は既存テストで継続確認。`git diff --check` とJS構文検査成功。凍結プロンプトSHA-256は `06bfefc4e758e54bf8b4b54714fa727e4be68cc6176bf529402fce69a9ba8db5` のまま。

実API・IAM/GCS回収・モデル互換性・精度・18〜22分性能・費用は未実測。合成模様と人工的な工程名の入力は接続手順の確認専用で、作業の正解・精度を意味しない。全方式unverifiedを維持する。


最終の画面確認では、案1 FewからZeroへの同一Stage1再判定が完了し、一時媒体「対象なし」、元の分析と標準作成は「削除完了」を確認。今回起動したモックサーバー（4173）とガイド表示専用サーバー（4180）は検証後に停止した。検証データは残している。
