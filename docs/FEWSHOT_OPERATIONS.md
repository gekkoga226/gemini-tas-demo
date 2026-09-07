# Round 18 運用・実接続手順

この手順の実API・精度・費用・20分性能は未実測。現行の操作可能なモックと区別する。実装開始順の例外は [実装記録](FEWSHOT_IMPLEMENTATION.md)、入力・評価の正は [Round 18](2026-09-06_FEWSHOT_SPEC.md)。公開・デプロイは今回行っていない。

## ローカル起動と保存

`npm.cmd start` または `node server.js`。既定は `MOCK_MODE=true`、localhost:4173。Node.js 20.11以上、FFmpeg/ffprobeが必要。PDF検証にはpdfinfoが必要。起動時に保存先の書き込み・ワーカーロック、媒体ツール、上限、実接続時の設定・認証取得を確認し、画面の入力状態へ反映する。

`DATA_ROOT`（既定data）を保全する。原本動画・標準画像・推論・修正は自動で一括削除しない。同じDATA_ROOTを使うワーカーは1つ。移動時はサーバーを止めてフォルダー全体をバックアップし、元とコピーのサーバーを同時に動かさない。Gitにはdata、data-real、connectivity-inputs、.local-validationを含めない（除外設定済み）。独自のDATA_ROOTはリポジトリ外に置く。除外設定は強制追加を防ぐものではなく、既に追跡されたファイルを解除するものでもない。

| 保存領域 | 内容 |
|---|---|
| media | 常設の登録原本、ハッシュ・長さ・MIME・音声情報 |
| build-inputs | 標準セット作成専用のGT原本。実評価GTはここに登録しない |
| vocabularies | 人が確認した語彙と識別条件、版、出典 |
| standard-sets | draft/preparing/ready/retired、公開時の不変manifest、profile、代表画像 |
| stage1-artifacts / stage1-cache / stage1-migrations | 不変の区間分割実体、方式別の参照、明示的な移行記録 |
| runs | run状態・受付snapshot・試行本文/生応答・不変result・修正reviews・完了後runtime |
| cleanup / comparison-sessions | 一時URI/ローカル変換の削除台帳と参照リース |
| versions / requests | 同じ版の内容変更防止とclient_request_idの冪等性 |

`result.json` は保存時点の不変記録。保存・回収自体の最終所要時間は `runtime.json`、現在の回収状態はジョブGETと台帳を参照する。履歴やAPIの状態と不変resultのcleanupスナップショットが異なる場合がある。

## 入力・公開・再利用

MP4はストリーミング受信し、上限・空き容量・ffprobeを確認。音声なしでは送信用コピーから音声を除去し、原点と動画長を検証する。元バイトと送信バイトのハッシュを別保存する。PDFはpdfinfoでページと暗号化を検査し、抽出後は確認待ちに置く。

標準セットの作成には標準動画、全長を隙間なく覆うGT（gt_segment_idとgt_process_idは一意）、確認済み語彙、識別条件を指定する。fixed Stage1に渡すGTは匿名IDと境界だけ。お手本ビューはlabelとObservationを対応付け、通常入力ではGT ID・元工程列・出現順を除く。

代表画像は各標準GT区間の20/50/80%位置で、指定時刻以上の最初の復号フレーム（存在しなければ区間内直前）を選び、重複を除く。小数秒演算の浮動小数点誤差は要求時刻をナノ秒桁に丸めて処理する。実PTS・元動画/GT出自・example/segment/image ID・FFmpeg設定・ハッシュを保存。回転適用、メタデータ除去、長辺768以下、拡大なし、JPEG q:v=2。公開後は画像・記述を書き換えず、新セットIDで作り直す。

通常のキャッシュキーは方式、動画ID/ハッシュ、送信ハッシュ、標準セット、語彙/識別条件、モデル・検証セッション、処理設定、プロンプト/スキーマ版等を含む。Zero/Fewはキーに含まない。案1/3は方式を除いた条件と入力全体の正規化ハッシュが一致した場合だけ同じartifactを参照。guidedは独立。

## 実接続への移行

GEAPはGemini Enterprise Agent Platform。動画モデルはGemini。Astraは実装担当で、動画分析モデルとして使わない。APIはv1beta1、mediaProcessingは動画Part直下。Files APIは使用せず、Cloud Storageのgs:// URIを渡す。通常は1リクエスト1動画、案3も標準フル動画を同時投入しない。

以下の値を担当者が確認した値に置換する。認証主体がAPIを呼ぶ権限と一時オブジェクトを作成・取得・削除する権限を確認する。動画を読む主体はAgent Platformサービスエージェントで、バケットの読み取り権限が別途必要（仕様4.3）。ローカルのgcloudログイン・対象プロジェクト・同意・送信範囲が揃うまで確認フラグを立てない。

```powershell
$env:MOCK_MODE = "false"
$env:DATA_ROOT = "data-real" # モック資産と分離する
$env:GEAP_AUTH_MODE = "gcloud"
$env:GEAP_PROJECT = "CONFIRMED_PROJECT_ID"
$env:GEAP_LOCATION = "CONFIRMED_LOCATION"
$env:GEAP_BUCKET = "CONFIRMED_TEMP_BUCKET"
$env:GEAP_STAGE1_MODEL = "CONFIRMED_GEMINI_MODEL_ID"
$env:GEAP_STAGE2_MODEL = "CONFIRMED_GEMINI_MODEL_ID"
$env:MODEL_REVISION_SCOPE = "YOUR_VALIDATION_SESSION_VERSION"
$env:GEAP_PRINCIPAL = "CONFIRMED_CALLER_IDENTITY"
$env:MAX_UPLOAD_BYTES = "2147483648" # 例。運用側で明示的に決定
$env:MIN_FREE_BYTES = "1073741824"  # 例。運用側で明示的に決定
# gcloud auth login を実施し、project・権限・送信対象を確認した後のみ:
$env:GEAP_ENVIRONMENT_CONFIRMED = "true"
node server.js
```

必要なら `GEAP_HOST` でHTTPSの接続先ホストを指定する。未指定では仕様のlocation付きaiplatformホストを構成するが、実互換性は未確認。各API試行直前にgcloudからtokenを取得し、401は1回再取得、403は反復しない。429/5xxは5秒・20秒、Retry-Afterが長ければそれを優先し2回まで。1回60分・全体3時間は停止条件であり、期待性能ではない。送信後timeout/切断は結果不明として自動再送しない。実接続の失敗をモックへ切り替えない。

Cloud Runへ移す場合は `GEAP_AUTH_MODE=service_account` と実行環境サービスアカウントを用いる。現状のローカルファイル永続化・単一ワーカーをそのまま複数インスタンスへ展開しない。Cloud Run化は今回の範囲外でありデプロイ済みではない。

## 中止・再起動・媒体回収

ジョブ作成は202とrun_idを返す。ブラウザは通常2秒ごとに状態を読む。通信失敗時は4秒、8秒、16秒、以降30秒間隔で再確認を続け、復帰後は通常間隔に戻る。画面の接続状態はサーバーの最終確認状態と別表示する。完了後も媒体回収が終わるまで更新する。保存先を切り替えて前回runが見つからない場合は履歴から選び直す。画面切断では中断しない。中止は対象runだけをcancel_requestedにし、以後の結果を確定しない。リモート計算停止は保証できず、結果不明として猶予を置く。

再起動はqueuedを継続、中間状態をinterrupted、保存済み有効resultがある場合はsucceededへ回復する。履歴の再試行は別runで、保存済みStage1が適合する場合に利用する。元結果・失敗・試行は残る。

削除台帳はアップロード/変換前に作り、正確なURI・generation・所有run・session・ハッシュ・期限・状態を記録。原本への一括削除は禁止。案1/2はStage1保存後、案3はStage2後にリース解除。結果不明は2時間、比較sessionは24時間（または明示終了）まで保護。失敗は1分/5分/30分/以降60分ごとに再試行し、24時間でcleanup_failedを表示しても再試行を継続する。404は削除済み。履歴から削除の再試行も可能。

標準画像の明示削除は先にセットをretiredにし、実行中参照と他セット参照がないことを確認する。通常の一時回収ではローカル常設画像を削除しない。プローブ停止後の回収は [専用手順](../tools/geap-probe/README.md) を使用する。

## 管理・開発用API

変更APIには `GET /api/session` のtokenを `x-local-token` に付ける。同一localhostのHost/Originだけを許可する。生のtokenは文書・ログへ貼り付けない。

| 操作 | API |
|---|---|
| 媒体登録 | POST /api/media（MP4/PDFのバイト、content-type、x-display-name） |
| 語彙抽出と人の登録 | POST /api/vocabulary-extractions、GET /{runId}、POST /{runId}/approve |
| 確認済みJSONの登録 | POST /api/vocabularies |
| 標準GT・セット作成 | POST /api/standard-set-build-inputs/gt、POST /api/standard-sets |
| 公開・利用停止・画像削除 | POST /api/standard-sets/{id}/approve、/retire、/delete-media |
| 分析・履歴 | POST /api/analysis-runs、GET /api/analysis-runs、GET /{runId} |
| 原本・表示・修正 | GET /api/analysis-runs/{id}/result、/display、GET/POST /reviews |
| 中止・再試行・削除再試行 | POST /api/analysis-runs/{id}/cancel、/retry、/cleanup-retry |
| 同じStage1で再判定 | 新しい分析入力にstage1_artifact_idとparent_run_idを付ける |
| 等価な実入力の明示移行 | POST /api/stage1-migrations |
| 生応答だけから安全網を再計算 | POST /api/analysis-runs/{id}/rederive-safety |
| 比較中の媒体リース | POST /api/comparison-sessions、POST /api/comparison-sessions/{id}/close |

各ジョブ作成には一意のclient_request_id。同じID・同じ入力は元run、同じID・異なる入力は409。Stage1の明示移行はartifact_id、標準set ID、analysis_strategy、settings、reason、editorを指定する。媒体・モデル・プロンプト・スキーマ・設定と正規化した全Stage1入力が等価なときだけ参照移行を許可する。guidedの語彙/識別条件変更は再生成。通常の自動失効を黙って回避しない。

安全網再計算はclient_request_idと新版safety_policyを指定する。例：`{safety_policy_version:"YOUR_NEW_VERSION",quality_policy_version:"quality-policy.v1",tie_margin:0.05,forced_confidence_cap:0.49,review_threshold:0.70}`。これは初期安全網設定で、精度合格閾値ではない。同じ版の内容変更は拒否し、生応答・元結果を残した派生runを保存する。追加モデル呼び出しはない。通常の再判定は全区間のStage2を実行する。

## 使用量・料金

全試行のusageMetadataを原形で残し、モデル応答のmodelVersion・agentic痕跡を保存する。痕跡なしはagentic_unconfirmed。入力種別の内訳を総量から逆算しない。モックの使用量はsyntheticで、実測費用を表示しない。

`GEAP_PRICE_TABLE` を使う場合は `geap-price-table.v1` のversion/currency/source/confirmed_at/modelsを指定。modelsの各要素はmodel_id、coverage_confirmed:true、components（usage_field、unit、price、description）。使用量フィールドの意味・思考token・キャッシュ割引・段階料金を運用側で確認した適切な内訳だけを設定する。表や必須使用量が不足すればnull。結果は全実試行のactual_spendと、共有Stage1を加えたstandalone_attributionを分離した概算で、請求確定額ではない。料金の推測既定値はない。

## 未実施の実測ゲート

モデルID/提供リージョン、host、v1beta1応答スキーマ互換、agentic発動、画像枚数・コンテキスト・出力上限、IAM、20分性能、実費、5区分の精度・確認負担、根拠の人による妥当性監査は未確認。既存Check 2は参考測定のまま。Check 0〜11の実機測定、事前基準と独立評価、運用故障確認が揃うまで3方式すべてunverifiedを維持する。


## 2026-09-08 レビュー修正後の操作・保管

- フォーム入力中は「区間に未反映」、反映後は「履歴に未保存」。別区間への移動・原本タブ切替・追加・Undo/Redo・境界操作の前に入力を検証して区間へ反映する。不正な入力は消さず、その場で修正を求める。
- 「修正を履歴に保存」「確認済みJSONを保存」は未反映入力も検証して反映する。保存に失敗すれば未保存のまま残る。ページを閉じる前にも未反映／未保存の確認を出す。保存中に追加入力した場合は未反映／未保存表示を残す。
- 人が追加した区間もJob No.を確認済み語彙から選び、作業名とページを連動させる。AI候補は作らない。
- 新規の `reviewed-result.v1` は `original_result` に不変のAI結果JSON全体を同梱する加算的拡張。`original_result_sha256` は同梱原本のハッシュ。`segments` は人の修正後、`changes` はAI原本からの差分、`editor` / `created_at` は確認者・日時。方式・動画ハッシュ・版・設定・共有元・元候補と根拠を単独で追跡できる。動画バイトや送信本文・生応答そのものを同梱するわけではない。候補・根拠・確信度はAI原本の情報で、人の修正ラベルの根拠ではない。
- 過去に保存済みの履歴は書き換えない。`original_result` がない旧ファイルはAI原本JSONと組で保管する。画面の「確認済みJSONを保存」は現在の修正内容から同梱版の新規履歴を作る。
- 順序逆転・時間逸脱などは対象区間へ具体的な確認文を表示。工程抜けはタイムラインの「動画全体の確認事項」に工程名を表示する。いずれも推論原本の警告として残し、人の修正で原本の判定を上書きしない。

実接続用の空の保存先からの準備は [接続ガイド](PRODUCTION_CONNECTIVITY_GUIDE.html) 手順6を参照。`node tools/prepare-connectivity-inputs.mjs` は合成MP4の作成・localhostへの登録と語彙／識別条件／動画IDの一致する標準GTの出力だけを行う。外部APIを呼ばず、モック結果も移植しない。別ポートなら末尾に `http://127.0.0.1:ポート` を指定する。FFmpegを環境変数で指定した場合は、コマンドを動かす別PowerShellにも同じFFMPEG_PATH / FFPROBE_PATHを設定する。

合成模様の映像と人工的な工程名は疎通専用であり、実際の動作を表す正解データではない。公開前に観察不足を含めて人が確認する。標準セット生成以降は実API処理となり得る。終了は今回の全runの媒体が「削除完了」、送信がなかったrunなら「対象なし」を確認してから行う。失敗・削除待ちは成功とみなさず、サーバーを停止する必要があればrunと台帳を保全し、再起動して回収を継続する。
