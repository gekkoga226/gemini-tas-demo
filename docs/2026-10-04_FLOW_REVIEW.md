# 二軸選択と合成フロー実験のレビュー記録

2026-10-04（日本時間）。対象は指定された `.claude/worktrees/ui-rebuild`。現行要件はRound 18、追加範囲は [実験契約](2026-10-04_FLOW_EXPERIMENT_CONTRACT.md)。この記録は実API・実動画の実測合格を示さない。

## 判断と保全

二軸UIと、合成モックに限定したE0処理・保存実験としてPRにできる。当初の実動画比較フローが完成したという判断ではない。複数coreでは人工継ぎ目の裁定を保留し、仮結果を保存してrunをfailedにする。継ぎ目裁定・継続証拠による出現結合・実験結果の人修正は未実装であり、本PRで品質や全体完成を表示しない。

開始ブランチは `feat/ui-stage5`、HEADは `44c049c485ec78b758e8aa12211d4776a317c218`。最新mainをfetchし、`9f5822e`（PR #14マージ）に対しbehind 1 / ahead 0。HEADとmainの追跡ファイル内容差は0だった。既存PR #14はMERGEDで、今回の未コミット実装を含む開いたPRはない。ブランチの切替・元フォルダの作業ファイル編集は行わない。Git共通メタデータの更新はworktreeでのfetch・commit・pushに必要な範囲のみ。

開始時の二軸関連変更は今回のレビュー対象。以前から未追跡の `docs/ui-mock-2026-10-03/` と `.local/` 資料は保全しステージしない。Round 18正本・既存凍結prompt・既存保存データは編集／一括再保存しない。

## 指摘と修正

| 指摘 | 修正・検出方法 |
|---|---|
| 実験結果を開いても旧resultと編集状態が残り、通常設定に戻すと旧Stage1で再判定できた | 未保存修正を先に保存し、失敗時は切替停止。通常result・プレイヤー・編集配列・再判定参照を解除。旧結果のメモ保全と再判定遮断をブラウザで確認 |
| persistingへ入った直後の中止を確認せず成功結果を保存できた | 最終確定と中止受付を排他にし、確定直前に中止を再確認。中止後の子保存も止める回帰試験 |
| 成功子再利用は子checksumだけを見て、生応答・送信本文の欠落／変更を見逃した | 入力条件に識別条件、prompt manifest、応答schemaを追加。送信本文・生応答・共有Stage1のchecksum／出典まで確認。生応答改変時に0呼出しで失敗する試験 |
| PTS検査は選択窓内だけで、別の場所の逆行・前方不連続を見逃した | 全原本PTSとpkt_duration、原点、末尾を先に検査。原本／派生全フレーム、実開始／終了・引数を保存。窓外の前方不連続も拒否する試験 |
| 成功子に採用区間がないcoreを完成扱いでき、保存済みcompleteの改変も読めた | 空coreを未説明時間にする。読取・再起動でrun SHA、子SHA、再統合、completeを検証。空core／仮結果成功化の試験 |
| 実験結果の安全網再計算を受け付け、旧結果処理へ進んだ | 専用契約未対応としてrun作成前に理由付き拒否する試験 |
| 既存結果の撮影ツールが最新の実験結果を通常結果として選ぶ | 自動選択を通常結果へ限定。実験結果が新しい履歴でも通常結果を2幅で撮影できることを確認 |

ワーカー終了と新run受付については、最終キュー走査後の受付を挿入し、1回だけ処理され空キューで停止することを検証した。新しい競合・無限反復は合成検証で検出されなかった。

## 二軸・推論・読取

既定はwhole＋text_only。分割の変更は分析方式を変更しない。「まとめて分析」は選択名称に使用しない。二軸は送信・snapshot・状態・result・履歴・retry・入力復元を通る。旧tas-result.v1／analysis-run.v1の既知の通常分析契約だけwholeと読み替え、由来不明の表示は方式情報なしとする。旧ファイルの書換えは行わない。

全体＋案1〜3は既存Stage1→Stage2の経路を維持する。分割＋案1〜3はチャンクStage1を共有し、案1／3のunguidedと案2のguidedを分離する。Zero/Fewの区間集合とPTS／core対応はStage2ラベルより先に固定する。既存Stage2検証は時刻追加を拒否する。同時判定は専用prompt・joint.input.v1／joint.response.v1を使い、各入力単位1呼出し、独立Stage1なし。GT・標準時刻を通常推論へ渡さず、凍結promptは検証する。

新結果はflow-experiment.result.v1の独立読取画面に出す。通常display／work-review、人修正、通常Stage1指定、既存比較session、安全網再計算への流入を理由付きで拒否する。出典・SHA・未解決・子失敗を表示し、存在しないStage1を作らない。

## 今回の検証

- `node --test test/flow-experiment.test.js test/media.test.js`：22/22通過。合成PTS表と物理合成CFR動画の範囲を区別。
- `npm.cmd test`：最終版168/168通過。過去の157件は今回の件数に流用していない。
- `npm.cmd run probe:self-test`：LOCAL_TESTS_PASSED。実測ゲートの状態変更なし。
- `node --test test/glossary.test.js test/narrow-layout.test.js`：12/12通過。
- 8組合せ・retryの二軸snapshot、分割＋案1〜3のZero/Few共有、GT隔離、構造不正／語彙外／Stage2時刻追加、PTS範囲外／二重offset／速度変更を検証。
- 601秒・32×32・2fpsの物理合成動画で3入力単位を切り出し、同時判定と案1〜3のZero/Fewを検証。各チャンクSHA・固定区間・core所有・末尾・媒体回収を確認。複数coreを成功扱いしないことも確認。
- 部分失敗／成功子再利用、中止／生応答保全、最終保存直前中止、保存故障／0呼出しretry、結果不明／自動再送なし、処理中再起動、成功保存と回収失敗の別状態、ワーカー終了時受付を検証。
- 空の専用TEMP DATA_ROOT・4189でブラウザ操作。既定、二軸独立、全体／分割の同時判定、旧結果からの切替、旧メモ保存、編集・再判定遮断、履歴・再読込で二軸復元、回収表示を確認。
- `node tools/ui-shots/shoot.mjs --base http://127.0.0.1:4189 --label flow-review-a1-retry --scenarios b-new,b-history --viewports 1280,400 --strict`：4画面撮影、横スクロール・はみ出し・切れ・12px未満・コントラスト違反0。実験結果全幅の自動走査はこの件数に含めない。
- 同ツールの `--label flow-review-legacy-reader-a1 --scenarios b-result-few --viewports 1280,400 --strict`：自動選択が最新の実験結果を避けて既存の通常結果を読むことを確認。2画面撮影、違反0。

修正前の新規回帰4件は4件とも失敗し、修正後に通過した。全テスト初回は167通過／1失敗。再起動試験が保存済み仮結果を処理中に書き換える不適切なfixtureだったため、結果未保存の処理中runへ修正した。後続の全件実行では通過。撮影の初回は制限環境でChrome接続が切れ、同じ読取撮影を権限付きで再実行して通過した。いずれも最終結果とは区別する。

ログ・撮影は `.local/flow-review-*.log` と `.local/ui-shots/flow-review-a1-retry/`。計測IDは `flow-review-20261004-codex-a1`、開始・終了とpruningを記録し、出力量はunknownとして欠測を残す。

## 実行可能範囲と未対応

新経路の受付条件はMOCK_MODE、サーバーが登録した合成動画、音声を含めない設定、0秒超〜7200秒、対応する公開profile／語彙・条件。UIサンプルは30秒なので分割を選んでも1coreになる。既定coreは300秒、paddingは15秒。複数coreの実験は仮結果・未解決となる。

実API adapter、実モデル/APIごとの入力支持範囲・所在地・料金、実動画の品質・費用、80／120分・16GB性能、実際のVFR・非ゼロ原点媒体の物理対応は未実装または未実測。サーバーの合成フラグとPTS検証は、実動画対応の代用ではない。実動画へ進むには専用API adapter・制約検査・既知イベント入りVFR／非ゼロ原点媒体による物理PTS検証・必要な継ぎ目裁定と独立review契約を別途実装／確認する。

継ぎ目の自動裁定・継続証拠による出現結合・実験結果の人修正は未対応。原因別の選択的再解析と保留中の別UI作業は追加していない。実接続、実動画利用、クラウド作成、merge、本番更新は行わない。

## ローカル合成モックの再現

Node.js 20.11以上、FFmpeg／ffprobeが必要。確認に使うDATA_ROOTは毎回新規作成し、4173・4190や既存data／data-realを指定しない。ポートが使用中なら空いている別番号を選ぶ。

```powershell
Set-Location 'C:\Users\mizuk\work\gemini-tas-demo\.claude\worktrees\ui-rebuild'
$env:MOCK_MODE = 'true'
$env:PORT = '4189'
$env:DATA_ROOT = Join-Path $env:TEMP ('tas-flow-demo-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $env:DATA_ROOT | Out-Null
npm.cmd start
```

1. `http://127.0.0.1:4189/analysis.html?new=1` を開き「合成サンプルで試す」。
2. 生成後に合成お手本の記述・画像を確認し、確認欄をチェックしてセットを公開。「閉じる」で入力へ戻る。
3. 分割方式と分析方式を別々に選択し、同意欄をチェックして開始する。実験を確認する例は「短く分割して結果を統合」＋「区間・作業名を同時判定」。
4. 専用仮結果で時間・出典・SHAと未解決を確認。実行履歴から結果を開き直し、二軸が復元されることを確認する。再読込後も復元する。
5. 起動したPowerShellでCtrl+Cを押して、このサーバーだけを停止する。DATA_ROOTには原本・結果・出典が残るので、必要に応じて手動保管する。

## 変更ファイル

`public/analysis.html`、`public/analysis-state.js`、`public/fewshot.js`、`src/pipeline.js`、`src/routes.js`、`src/flow-experiment.js`、`src/media.js`、`src/mock-model.js`、`prompts/joint_experiment_v1.md`、`prompts/joint_experiment.v1.json`、`test/flow-experiment.test.js`、`tools/ui-shots/main.mjs`、`docs/README.md`、`docs/2026-10-04_FLOW_EXPERIMENT_CONTRACT.md`、本記録。利用者の未追跡モック資産は含めない。
