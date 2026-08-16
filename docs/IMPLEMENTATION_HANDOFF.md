# 実装フェーズ引き継ぎ

- 作成日: 2026-08-15
- 現在の状態: **background依存を外したローカル検証モックを実装済み。**
- この資料の目的: background executionの既知制約と、ローカル検証モックの実装方針を後続作業へ引き継ぐ。

## 2026-08-15 実装方針変更

ユーザー指示により、GET polling/cancelが成功するまで実装を停止する旧ゲートは、background executionを必須にしない設計へ変更した。既定は `MOCK_MODE=true`、実APIはFlashの同期テキスト要求だけとする。実装・検証結果は `docs/IMPLEMENTATION_RESULT.md`、優先制約は `docs/DESIGN.md` 1.1を参照する。

旧ゲートの実測記録と当時の判断は履歴として以下に残すが、現在のローカルモック実装を停止する条件ではない。

## 必ず最初に確認する資料

1. `docs/SPEC.md`（正式要件）
2. `docs/DESIGN.md`（承認済み設計）
3. `docs/20260815_DESIGN_REVIEW.md`
4. `docs/20260815_DESIGN_REVIEW_2.md`
5. `docs/IMPLEMENTATION_PRECHECK.md`（第1ゲートの実測記録）
6. `reference/validated_prompt.md`（変更禁止）
7. `reference/gemini_validation_notes.md`
8. `git status`
9. `git log --oneline`

## 既存の作業ツリー

次の既存変更はユーザーの設計フェーズ成果物である。削除、上書き、巻き戻し、コミットをしない。

- `docs/SPEC.md`: 変更済み
- `docs/DESIGN.md`: 未追跡
- `docs/20260815_DESIGN_REVIEW.md`: 未追跡
- `docs/20260815_DESIGN_REVIEW_2.md`: 未追跡
- `docs/IMPLEMENTATION_PRECHECK.md`: 未追跡（今回の疎通記録）

## 第1ゲートの実測結果

動画・PDFは一切送信していない。`GEMINI_API_KEY` の値は表示、保存、ログ出力していない。

成功した項目:

- `models.list` による認証と候補3モデルの利用可否
- `gemini-3.1-pro-preview`、`gemini-3.5-flash`、`gemini-3.6-flash` の入力上限 `1,048,576`、出力上限 `65,536`
- `countTokens` による検証済みプロンプトの実トークン数: 3候補すべて `584`
- 正式9項目の最小JSON Schemaを指定した`response_format`の受理
- `background=true` によるinteraction作成（3候補すべて初期状態 `in_progress`）
- テストinteractionの `DELETE /interactions/{id}`

未解決の項目:

- `GET /interactions/{id}` がHTTP 403 `permission_denied`
- `POST /interactions/{id}/cancel` がHTTP 403 `permission_denied`

このため、background executionの状態追跡・中止を設計どおりに実行できることは未確認である。APIキーの種類・関連Google Cloudプロジェクト・Interactions APIへの権限を確認し、**テキストのみ**でGET pollingとcancelが成功するまで実装へ進まない。原因は権限またはAPI提供側の状態の可能性があるが、現時点では断定しない。

## 新しいチャットでの実施順序

1. 上記資料とGit状態を読む。
2. `GEMINI_API_KEY` の存在だけを確認する。値を検索、表示、保存、ログ出力しない。
3. 実動画・実PDFを送らずに、background interactionを作成し、GETによる状態取得とcancelをテストする。テストinteractionは削除を試み、IDを記録しない。
4. 結果を `docs/IMPLEMENTATION_PRECHECK.md` へ追記する。失敗なら原因、影響、再試行可否を記録して停止する。
5. 第1ゲートの全項目が成功した場合だけ、`docs/DESIGN.md` に従ってローカルMVPを実装する。

## 実装時の必須制約

- 実動画・実PDFのGemini送信は、ユーザーの別途明示許可まで行わない。
- ブラウザ画面とローカル処理サービスを分離し、APIキーをブラウザへ渡さない。
- `reference/validated_prompt.md`、正式JSON 9項目、`docs/SPEC.md`を独断変更しない。
- `response_format` は既定で使用する。Schemaが受理されない場合に無断でOFFにしない。
- `max_output_tokens` は `min(65536, モデル公式最大値)`。今回の確認値では3候補とも `65536`。
- `prediction.json` はAI応答値を不変で保持し、`reviewed.json` は編集結果のみを出力する。
- 時刻は1秒単位・厳密な`HH:MM:SS`で、自動正規化しない。
- 動画終端は `ceil(実動画長)` 秒として検証する。
- 入力はMP4 1本とPDF 1冊、動画上限は2GB以下。動画時間・PDFページ数を取得できなければ解析開始不可。
- 概算入力トークンは `ceil(動画秒数) × 300 + PDFページ数 × 258 + 584` を用いる（再確認値）。
- interactionの全終端状態、取消、サービス再起動、ファイル・ID記録の削除はDESIGN 3.5、3.6、5.3、8章、9章に従う。
- 依存関係は最小限にし、理由を報告する。
- コミット、push、PR作成はユーザーの明示依頼があるまで行わない。

## 疎通時の注意

PowerShellで `Get-Content -Raw` の戻り値をそのまま `ConvertTo-Json` へ渡すと、環境によって文字列の付加情報までJSON化され、要求が巨大化することがあった。第1ゲートでは送信前に通常の文字列へキャストして回避した。これはPowerShellの検証用スクリプトの注意点であり、アプリ実装の仕様変更ではない。

## 実装完了時に報告すること

1. 第1ゲートの最終確認結果
2. 実装した機能と未実装機能
3. 変更したファイル一覧
4. 実施したテストと結果
5. 実動画・実PDFが未提供のため未検証の項目
6. 次にユーザーの許可が必要な作業
7. `git status` の結果
