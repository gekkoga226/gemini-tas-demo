# 開発・検証手順

変更する機能に対応する資料を [docs索引](README.md) から選び、該当節と関連する実装・テストだけを確認する。

## 確認方針

- コード変更時は関連テストを実行し、完了前に以下の全テストを確認する。プローブ・評価処理を変更した場合は自己検査も行う。
- UI変更時は関連する操作をブラウザで確認し、未反映入力、保存、原本と修正の分離など変更に関わる挙動を検証する。
- 文書だけの変更は差分・参照先・編集範囲を確認する。アプリ起動や実API呼出しは不要。
- 結果には実行コマンド、確認範囲、失敗・未実施事項を記録する。過去の成功件数を今回の検証結果として使わない。

## 検証コマンド

```powershell
npm.cmd test
npm.cmd run probe:self-test
```

全テストは外部API不要です。実API用アダプターのテストも通信を置き換えています。プローブ自己検査は合成データのCheck 7〜11、ジョブ故障経路、採点の手計算例を実行し、実測Checkの状態を変更しません。

実測の入力・実行方法・未確認事項は [GEAPプローブ](../tools/geap-probe/README.md)。旧MVP資料・旧Flashテキスト疎通テストは歴史的互換検証として残しています。画面は新しい永続ジョブAPIだけを使い、旧 `/api/analyze` の実接続は通常起動では廃止しています。

## 画面のCSS

B（`public/analysis.html`）は `public/ui-base.css`（色・余白・角丸・文字・書体のトークンと、カード・ボタン・タブ・通知・入力欄・ダイアログなどの共通部品）を先に、`public/styles.css`（B の画面の配置）を後に読み込む。これから作る画面も `ui-base.css` を先に読み込み、トークンと共通部品を使う。`!important` は `[hidden]` だけに使い、上書き用のCSSファイルを増やさない。

Bの基本の幅は1200pxと720px。1200px未満は結果を縦に積み、720px以下は小画面の操作配置にする。1599pxの列調整・高さ800pxなど既存の例外は残す。幅の変更では新しい分析・履歴・ライブラリも確認する。旧Aの計算・JSON例は `test-support/legacy-review/` に保存し、互換テストだけで使用する。新しい表示モジュールは `test/glossary.test.js` の `SCREEN_B_FILES` に登録する。

## 画面の撮影と自動チェック

`tools/ui-shots/` は Chrome を自動操作して画面を撮影し、画面・幅ごとに「ページの横スクロール」「ボタン・タブ・ラベル等からのはみ出し」「中身が切れている箱（`overflow` が `hidden`／`clip` の枠より、中身が高さ方向に1px以上はみ出して見えない。スクロールできる枠と、行数を決めて省略する枠は数えない）」「12px未満の文字」「コントラスト4.5:1未満」を数える。Node.js 22以上が必要（組み込みの WebSocket を使う）。外部パッケージは使わない。撮影は別ポートのモックで、空の一時フォルダを `DATA_ROOT` にして行い、4173番・`data-real/`・既存の `data/` は使わない。

```powershell
# 別のウィンドウで、別ポートのモックを起動する（DATA_ROOT は空の一時フォルダ）
$env:MOCK_MODE = "true"; $env:PORT = "4180"; $env:DATA_ROOT = "$env:TEMP\tas-mock-data"
New-Item -ItemType Directory -Force $env:DATA_ROOT | Out-Null
npm.cmd start
node tools/ui-shots/shoot.mjs --label 2026-09-28_before
node tools/ui-shots/shoot.mjs --base http://127.0.0.1:4186 --scenarios page --paths /index.html --viewports 1920x950,400 --strict
```

- 既定：接続先 `http://127.0.0.1:4180`、出力先 `.local/ui-shots/<ラベル>/`（PNG・`report.json`・`summary.txt`）、画面幅 1920×950・1600・1280・1000・720・400（高さ1000）、シナリオ `app`（B の新しい分析・実行履歴・お手本ライブラリ・結果（お手本なし／あり／最初の要確認／メモタブ）、お手本なしのST平均／合計／1回ごと／修正後／時間の分析／区間／メモ、使い方、表・出典を開いたライブラリ）。一覧は `--help`。
- Chrome の場所は `--chrome` か環境変数 `UI_SHOTS_CHROME`（既定 `C:/Program Files/Google/Chrome/Application/chrome.exe`）。ブラウザの作業用フォルダは OS の一時フォルダに作り、終了時に消す。
- 安全策：4173番・ローカル以外・`/api/health` が mock でない接続先は拒否する。シナリオは結果を読み、タブ・表示元・開閉など表示の操作だけを行い、接続先以外への通信と GET 以外の通信は遮断して記録する。出力先にファイルがあれば中止する（`--overwrite` で上書き）。
- 既存のデータでは起動しない：サーバーは起動しただけで、実行ごとの記録（`run.json`）を書き直す。結果ファイルのある実行は `succeeded`（完了）に、取り消しを求めていた実行は `cancelled`（中断）に、途中で止まっていた実行は `interrupted`（前回処理の中断）に直される（`src/pipeline.js` の起動時の回復処理）。画面を見るだけのときも `data/` などの既存のフォルダは指定せず、上の例のように空の一時フォルダを使う。撮影が終わったらサーバーを止めて、その一時フォルダを削除する。
- 結果画面は、実行履歴で最新の完了分を使う（`--few-run`・`--zero-run` で指定）。該当がなければ省略する。空の一時フォルダで起動した直後は実行履歴がないので、結果画面も撮るときは、先にモックの画面で「合成サンプルで試す」から分析を実行しておく（操作は [操作ガイド](USER_GUIDE.md)）。
- 終了コード：0 正常、1 違反あり（`--strict` のとき）、2 指定・環境の誤り、3 撮影できない画面あり。Git Bash では `/` で始まる引数が書き換えられるため、`MSYS_NO_PATHCONV=1` を付ける。
- 自動チェックは目安で、目視の確認を置き換えない。コントラストは文字の大きさによらず4.5:1で判定し、画像・グラデーション・動画の上の文字と無効化された操作は「対象外」として別に数える。

## 観察分析・レビュー由来見本の検証

追加契約は[観察レビュー往復](2026-10-04_OBSERVATION_REVIEW_CYCLE_CONTRACT.md)。関連テストは `node --test test/discovery-cycle.test.js test/implementation-assets.test.js test/start-real.test.js test/glossary.test.js`。REAL adapter・HTTP経路は通信・認証・クラウドを置換し、TEMP保存先で検証します。資産欠落・読取失敗の検証は専用TEMPの隔離コピーだけで行います。従来の8組合せはflow-experiment/fewshotの回帰検証を継続します。

`tools/ui-shots`の追加シナリオはb-discovery、b-discovery-zero、b-discovery-review、b-discovery-standard、b-discovery-library。空の専用TEMPでA→review→見本→Bを操作した後、その専用モックを撮影対象にします。従来の結果シナリオは新契約を選択しません。今回の検証と再現手順は[報告](2026-10-05_OBSERVATION_REVIEW_CYCLE_REPORT.md)。
