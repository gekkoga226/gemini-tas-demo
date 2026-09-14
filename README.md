# 作業みえる — 動画の作業レビュー

動画と作業区間、標準との比較、時間の分析、実施手順書を同じ結果データから確認するアプリです。Zero-Shot／Few-Shotを切り替え、映像で区間を確認・修正し、JSON・CSVに保存できます。初期画面は120分の架空サンプルです。

既存のRound 18分析・標準セット管理は「分析の実行・見本の管理」にあります。主画面で選ぶ動画はブラウザ内で再生し、分析履歴の結果は原本を保ったレビュー用コピーとして開きます。新画面の操作と仕様の適用関係は [再構築の記録](docs/WORK_REVIEW_REBUILD.md) を参照してください。

実API・精度・18〜22分性能・費用は未実測です。検証状況は [実装記録](docs/FEWSHOT_IMPLEMENTATION.md)、必要な資料の入口は [docs索引](docs/README.md) を参照してください。

## 起動と主要操作

[運用手順の起動・必要ツール](docs/FEWSHOT_OPERATIONS.md#ローカル起動と保存)を確認し、リポジトリのルートで実行します。

```powershell
$env:MOCK_MODE = "true"
npm.cmd start
```

[ローカル画面](http://127.0.0.1:4173/)を開くと操作用サンプルを確認できます。実行基盤の操作は [分析・見本管理画面](http://127.0.0.1:4173/analysis.html) と [モック操作ガイド](docs/USER_GUIDE.md) を参照してください。

## 方式と保存

方式・入出力契約は [Round 18仕様書](docs/2026-09-06_FEWSHOT_SPEC.md) の第5〜8章、保存領域と保全は [運用手順](docs/FEWSHOT_OPERATIONS.md#ローカル起動と保存) を参照してください。

## 設定

環境変数の用途と既定値は [設定一覧](docs/FEWSHOT_OPERATIONS.md#設定)、実接続は [運用手順](docs/FEWSHOT_OPERATIONS.md#実接続への移行) と [接続ガイド](docs/PRODUCTION_CONNECTIVITY_GUIDE.html) を参照してください。

## 検証

[開発・検証手順](docs/DEVELOPMENT.md) にコマンドと確認方針をまとめています。
