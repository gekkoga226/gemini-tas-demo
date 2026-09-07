# ローカル検証モック 実装・検証結果

> 2026-09-07: 以下は2026-08の旧版の実施記録。現行Round 18の変更・ローカル検証・未実測ゲートは [FEWSHOT_IMPLEMENTATION.md](FEWSHOT_IMPLEMENTATION.md) を参照。下記結果を今回の実API互換性・精度合格として扱わない。

- 実施日: 2026-08-15
- 既定モード: `MOCK_MODE=true`
- 対象: ローカル画面、ローカルバックエンド、Flash同期テキスト疎通

## 実装結果

- Node.js標準機能だけで、`127.0.0.1` 専用のローカルサーバーを実装した。
- 起動ごとのローカル操作トークン、Host/Origin検査、CSPを実装した。APIキーはバックエンドだけが環境変数から読み、ブラウザへ返さない。
- モックモードではGeminiへ通信せず、入力動画の秒数に収まる決定的な正式9項目JSONを返す。
- 画面の「準備中 → 解析中 → 結果を整形中 → 完了」は `LOCAL_MOCK_STAGES` によるローカル模擬進捗であり、Geminiの進捗ではない。
- UIに、ファイル選択・ドロップ、サンプル入力、開始、経過時間、中止、結果一覧、タイムライン、動画連動、時刻・Job No.・ページ・タイトル編集、端点ドラッグ、区間追加・削除、Undo/Redo、予測/確認済みJSON出力を実装した。
- `prediction.json` 相当はAI/モック応答の値を保持し、`reviewed.json` 相当は時刻から `duration_seconds` を再計算する。

## background executionを使わない実API経路

- `MOCK_MODE=false` でも `background=true` は送信しない。
- 同期 `POST /v1beta/interactions` だけを使い、`store:false` を指定する。
- interaction IDのGET polling、Gemini cancel、DELETE、IDの保存・表示・ログ出力は実装しない。
- 実APIは `gemini-3.5-flash` と `gemini-3.6-flash` だけを許可する。`gemini-3.1-pro-preview` は設定の既定値として保持するが、実行前に拒否する。
- 実API中止時はブラウザのAbortControllerで待機を終了し、ローカルサーバーも上流HTTPを中断する。後着結果は画面へ反映しない。ただしGeminiクラウド側の処理停止は保証しない。

## 検証結果

### 自動テスト

`node --test` を実行し、8件すべて成功した。

- 厳密な `HH:MM:SS` と秒変換
- 決定的モックの正式9項目、A/B検証合格
- 予測原本の `duration_seconds` 保持と確認済み結果の再計算
- 項目不足・型違反のA検証拒否
- 実API要求がFlash限定、同期、`store:false`、backgroundなし、テキストのみであること
- Proモデルをネットワーク要求前に拒否すること
- ローカル操作トークンと、応答へID・秘密値を含めないこと
- Host/Originによるローカル限定アクセス

### ブラウザ通し確認

ファイル内容を持たないサンプル入力で次を確認した。

- 解析開始とローカル模擬進捗
- 正式9項目を持つ4区間の結果・タイムライン表示
- 中止によりローカル模擬処理が停止し、以前の成功結果が保持されること
- 作業タイトル編集、未出力表示、Undo/Redo
- 区間削除と追加
- AI予測JSON、確認・修正済みJSONの出力操作。確認済み出力後に未出力表示が解除されること
- ブラウザコンソールのエラー・警告なし

### Flash実API

環境変数の値を表示・保存せず、`gemini-3.6-flash` へ固定テキストだけを同期送信した。HTTP応答から正式9項目の2区間を取得し、A検証に合格した。

- `background` は未指定
- `store:false`
- 実動画・実PDFは未送信
- interaction IDと応答本文は未表示・未保存・未ログ出力
- Proモデルは未実行

## 残る制約

- Gemini Interactions API提供側の状態依存403により、実行中interactionの通常GET/cancelは利用しない。
- 実APIモードの「中止」は画面上の待機とローカルHTTPを止める操作であり、「Geminiクラウド上の処理を停止した」とは表示・保証しない。
- 実動画・実PDFを使ったGemini解析、2GB動画、代表42ページPDF、動画コーデック、PDFの複雑なページ構造は未検証である。
- ブラウザ側の依存なしPDFページ数確認は簡易検査である。複雑なPDFでページ数を取得できない場合は解析開始せず、別のPDFを案内する。
