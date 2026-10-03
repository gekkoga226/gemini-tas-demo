# 作業みえる — 動画の作業レビュー

動画を分析し、作業区間・お手本との時間差・STとの比較・時間の内訳を確認するアプリです。お手本の有無を選び、映像で区間を確認・修正し、履歴へ保存してJSONに書き出せます。トップ画面は新しい分析の開始画面です。実施手順書は後回しです。

Round 18分析・お手本セット管理はトップの分析画面にあります。実行履歴の結果は原本を保った修正用コピーとして開きます。現行の操作は [操作ガイド](docs/USER_GUIDE.md)、段階5の決定と実装範囲は [段階5記録](docs/2026-10-03_UI_STAGE5.md) を参照してください。

実API・精度・18〜22分性能・費用は未実測です。検証状況は [実装記録](docs/FEWSHOT_IMPLEMENTATION.md)、必要な資料の入口は [docs索引](docs/README.md) を参照してください。

## 起動と主要操作

[運用手順の起動・必要ツール](docs/FEWSHOT_OPERATIONS.md#ローカル起動と保存)を確認し、リポジトリのルートで実行します。

```powershell
$env:MOCK_MODE = "true"
npm.cmd start
```

モックは映像を解析しない合成結果です（`start-app.bat` も常にモック）。実映像の判定は `start-app-real.bat` で起動します（[実接続への移行](docs/FEWSHOT_OPERATIONS.md#実接続への移行)）。

[ローカル画面](http://127.0.0.1:4173/)を開くと新しい分析の開始画面に進みます。旧 `/review.html` も新しい分析の入口へ転送します。旧画面の結果JSON読込・CSV・架空120分サンプルは終了しました。詳しい操作は [モック操作ガイド](docs/USER_GUIDE.md) を参照してください。

## 方式と保存

方式・入出力契約は [Round 18仕様書](docs/2026-09-06_FEWSHOT_SPEC.md) の第5〜8章、保存領域と保全は [運用手順](docs/FEWSHOT_OPERATIONS.md#ローカル起動と保存) を参照してください。

## 設定

環境変数の用途と既定値は [設定一覧](docs/FEWSHOT_OPERATIONS.md#設定)、実接続は [運用手順](docs/FEWSHOT_OPERATIONS.md#実接続への移行) と [接続ガイド](docs/PRODUCTION_CONNECTIVITY_GUIDE.html) を参照してください。

## 検証

[開発・検証手順](docs/DEVELOPMENT.md) にコマンドと確認方針をまとめています。
