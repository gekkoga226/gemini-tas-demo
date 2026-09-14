# 2026-09-12 GCP実接続 疎通確認の記録と引き継ぎ

個人Googleアカウントで作成したGCP環境に対する実接続の測定記録。要件の正本は [Round 18仕様書](2026-09-06_FEWSHOT_SPEC.md)、運用方法は [運用手順](FEWSHOT_OPERATIONS.md)。本書はその時点の測定記録であり、独立した規則を追加しない。

**最新状態（2026-09-13）**：合成データの標準セット作成から案1 Few-shotの解析Stage2まで、最終実行は失敗・API再試行なしで完了。GCSの一時媒体は回収済み。判断・追加の失敗も含む実測・残件は第9章。

第1〜8章は2026-09-12の先行測定・引き継ぎの履歴として保全する。当時の未決事項は第5章で、以降の判断と実装は利用者から一任された。第9章が判断後の状態を示す。

## 1. 確認済みの環境

| 項目 | 値 |
|---|---|
| プロジェクトID / 番号 | `tas-connectivity-test` / `737074606602` |
| 請求先 | `01367F-E6364E-06A4CC`（個人アカウント・無料トライアル） |
| 予算 | 月500円。サービス指定「Gemini API」「Vertex AI」の2本＋利用額上限「構成済み」 |
| 有効API | `aiplatform.googleapis.com`、`storage.googleapis.com` ほか。Agent Platformの一括有効化を実行済みで20個以上が有効 |
| バケット | `gs://tas-connectivity-test-probe-20260912`（us-central1、均一アクセス、公開防止=強制） |
| サービスエージェント | `service-737074606602@gcp-sa-aiplatform.iam.gserviceaccount.com` に `roles/storage.objectViewer` を付与。IAMポリシーで反映確認済み |
| 認証主体 | `mizuko226@gmail.com`（`gcloud auth login` 済み、ADCあり） |
| ローカル環境 | Node v24.11.1 / FFmpeg 4.4.2 (`C:\ffmpeg-4.4\bin`) / pdfinfo 25.07.0 (winget `oschwartz10612.Poppler`) / Google Cloud SDK 584.0.0 |

予算のサービス指定は、Vertex AIのGemini Enterprise Agent Platformへの改称により課金明細上のサービス名と一致しない可能性がある。サービス指定なしの予算を別途作ることを推奨するが未実施。

## 2. 実測で判明した事実

いずれも本日の実行で確認したもの。推測は含めない。

### F-1 Gemini 3系はglobalエンドポイントで提供される（重要）

`gemini-3.6-flash` はモデル一覧に載り `launchStage=GA` だが、`https://us-central1-aiplatform.googleapis.com/v1beta1/projects/{p}/locations/us-central1/...` へ投げると **404 NOT_FOUND**。

`https://aiplatform.googleapis.com/v1beta1/projects/{p}/locations/global/publishers/google/models/gemini-3.6-flash:generateContent` へ投げると成功する。モデル一覧に出ることと、そのリージョンで呼べることは別。

アプリ側は `src/settings.js:9` が `https://{location}-aiplatform.googleapis.com` を組み立てるため、Gemini 3系を使うには `GEAP_HOST` の明示指定が必須。`GEAP_LOCATION=global` + `GEAP_HOST=https://aiplatform.googleapis.com` で `src/geap.js:39` の組み立て結果が成功URLと一致することを実機で確認した。

これにより [運用手順](FEWSHOT_OPERATIONS.md) の「`GEAP_HOST` 未指定では仕様のlocation付きaiplatformホストを構成するが、実互換性は未確認」という記述に対する測定結果が得られた。文書への反映は未実施（第5章 D-4）。

### F-2 提供リージョンとモデル世代

- `us-central1`：`gemini-3.1-pro-preview` / `3.5-flash` / `3.6-flash` / `3.7-flash` / `3.8-flash` ほかGemini 3系が揃う（publisher models 132件）
- `asia-northeast1`（東京）：`gemini-2.5-flash` と `gemini-2.5-pro` の**2つのみ**。`gemini-2.5-flash` の実呼び出し成功を確認

実業務動画を国内に置く要件がある場合、Gemini 3系との両立ができない。これは事業側の判断事項（第5章 D-2）。

### F-3 ADCのクォータプロジェクト

`gcloud auth application-default login` だけでは、プロジェクトを含まないURL（publisher models一覧など）が Google 共有プロジェクト `32555940559` に解決され `SERVICE_DISABLED` で403になる。`gcloud auth application-default set-quota-project tas-connectivity-test` を実行済み。プロジェクトを含むURLではこの問題は起きないため、アプリ本体の動作には影響しない。

### F-4 PowerShellからの呼び出しで HTTP 417

`Invoke-RestMethod` が既定で送る `Expect: 100-continue` をGCP側が拒否する。GCP側の問題ではない。回避は `[System.Net.ServicePointManager]::Expect100Continue = $false`。

### F-5 gcloudのPATH反映

`GEAP_AUTH_MODE=gcloud` のとき `src/geap.js:13` は `powershell.exe -NoProfile -NonInteractive -Command "& gcloud.cmd auth print-access-token"` を呼ぶ。`-NoProfile` のため `gcloud.cmd` がシステムPATH上にある必要がある。Cloud SDKインストール前から開いていたシェルからサーバーを起動すると、PATHが未反映で `AUTH_REQUIRED` になる。インストール後は新しいターミナルから起動すること。

## 3. 実施した変更

### 3.1 audio_cues の契約緩和

実接続のStage1が全区間で構造不正となり失敗した。

```
INVALID_STAGE1: audio_cues: 値・根拠・不足理由が不整合
```

実モデル（`gemini-3.6-flash`、temperature 0）は音声なし入力に対し、4区間すべてで `audio_cues` を `{"status":"not_applicable","value":null,"evidence_ids":[]}` と返した。`unobserved_occlusions` には他6項目のみを記載し、`audio_cues` を含めなかった。旧規定は「status が observed 以外の全項目に `unobserved_occlusions` のエントリが必要」であったため不正と判定された。`src/mock-model.js:7` はエントリを作るためモックでは発覚しなかった。

利用者の判断により、`not_applicable`（その入力条件では対象が存在しない）は記載を任意とする方針を採用した。

| 変更 | 内容 |
|---|---|
| `src/contracts.js:44` | `not_applicable` は `unobserved_occlusions` を要求しない。`unknown` は従来どおり理由が必須 |
| `docs/2026-09-06_FEWSHOT_SPEC.md:285` | 仕様本文を改訂。変更理由・根拠日・旧規定の有効期間を明記 |
| `test/observation-contract.test.js` | 新規。実モデルが返した形を固定し、`unknown` の厳格さと音声条件違反の検出が残ることも検証 |

検証結果：`npm test` 58件全通過、`npm run probe:self-test` は `LOCAL_TESTS_PASSED`。全テストの通過には `PDFINFO_PATH` の設定が必要。

修正後、標準セット作成（Stage1 × unguided/guided の2プロファイル）と解析のStage1が実接続で成功した。

### 3.2 環境整備

- poppler（pdfinfo 25.07.0）を winget で導入
- ADCクォータプロジェクトを設定（F-3）

## 4. 現在の到達点

| 経路 | 状態 |
|---|---|
| gcloudトークン取得（サーバー内） | 成功 |
| 合成MP4のGCSアップロード | 成功 |
| 標準セット作成 Stage1 × 2プロファイル | 成功・公開済み（`55ee0da6-9d87-4dcb-9ea0-2d1dc688c610`） |
| 解析 Stage1 | 成功 |
| 解析 Stage2 | **失敗**（第5章 D-1） |
| 媒体の自動回収 | 成功。全3runが `deleted`、バケットは空 |

実呼び出し5回・合計54,830トークン。

### agentic痕跡について

`findAgenticTraces`（`src/geap.js:17`、`processingCall` / `processingResult` を探索）は全試行で0件。リポジトリの定義では `agentic_unconfirmed` のまま。ただし `usageMetadata.toolUsePromptTokenCount` に IMAGE 1,584 / TEXT 2,372 が計上されており、媒体処理自体は行われている。痕跡キーの形式が変わった可能性があり、検出条件の見直し余地がある（第5章 D-3）。

## 5. 未決事項

### D-1 Stage2 の根拠参照スキーマ（最優先）

解析のStage2が失敗する。

```
INVALID_STAGE2: ref: 観察項目/構造不正
```

実モデルが返した根拠参照（2件とも同形）は `{"kind":"observation","segment_id":"seg-0001","video_id":""}`。

`src/contracts.js:113` は `kind:'observation'` に対し `['kind','segment_id','field','evidence_id']` の完全一致を要求する。返答には `field` と `evidence_id` がなく、代わりに空の `video_id` が含まれる。

原因は指示ではなくAPIへ渡す応答スキーマにある。`src/response-schemas.js:13` の `ref` は4種類のkindの項目を1つのオブジェクトに平坦化し、`required` を `['kind']` のみとしている。

プロンプト `prompts/stage2_text_v1.md:6` は `{kind:"observation",segment_id,field,evidence_id}` と正しく指示しているが、スキーマ側が `field` / `evidence_id` を強制せず、かつ `video_id` を正当なプロパティとして提示しているため、モデルはスキーマ上は合法で契約上は不正な応答を返せる。`src/response-schemas.js:1` のコメント「API acceptance is unmeasured. Server validators are authoritative and stricter.」が指していた未測定部分が表面化した形。

検討した選択肢（いずれも未実施）:

1. 条件ごとにスキーマを絞る。映像・画像を使わない条件では `video_id` / `image_id` / `start_s` / `end_s` を出さず、`field` と `evidence_id` を `required` に含める。基本機能だけで実現できる
2. `anyOf` でkindごとに分岐させる。最も正確だが、Vertexの `anyOf` 対応を実測で確認する必要があり未測定ゲートが増える
3. プロンプトを強化する。ただし現行プロンプトは既に明示的であり、プロンプトは `prompt_manifest_sha256` で版凍結されているため新リリース版の作成が必要

サーバー側検証の緩和は、根拠追跡性を損なうため採らない方針で検討した。

スキーマ変更は結果JSONの `versions.stage2_schema.sha256` に影響する。版管理上の扱いは未確認。

### D-2 データ所在地とモデル世代（事業側の判断）

F-2のとおり、国内リージョンではGemini 2.5世代までしか使えない。実業務動画を扱う段階で決定が必要。今回の合成データによる疎通確認には影響しない。

### D-3 agentic痕跡の検出条件

第4章のとおり、`findAgenticTraces` の探索キーが実応答の形式と一致していない可能性がある。実応答は `data-real/runs/*/responses/` に保存済みで、通信なしで再検討できる。

### D-4 文書への測定結果の反映

F-1により [運用手順](FEWSHOT_OPERATIONS.md) の `GEAP_HOST` に関する未確認記述と「未実施の実測ゲート」節の一部に測定結果が出た。[実装記録](FEWSHOT_IMPLEMENTATION.md) への日付付き検証記録の追加も含め未実施。未実施ゲートを合格扱いにしないこと。

## 6. 再現手順

Cloud SDKインストール後に開いた新しいターミナルから実行する（F-5）。

```powershell
$env:MOCK_MODE = "false"
$env:DATA_ROOT = "data-real"
$env:GEAP_AUTH_MODE = "gcloud"
$env:GEAP_PROJECT = "tas-connectivity-test"
$env:GEAP_LOCATION = "global"
$env:GEAP_HOST = "https://aiplatform.googleapis.com"
$env:GEAP_BUCKET = "tas-connectivity-test-probe-20260912"
$env:GEAP_STAGE1_MODEL = "gemini-3.6-flash"
$env:GEAP_STAGE2_MODEL = "gemini-3.6-flash"
$env:MODEL_REVISION_SCOPE = "2026-09-12-connectivity"
$env:GEAP_PRINCIPAL = "mizuko226@gmail.com"
$env:MAX_UPLOAD_BYTES = "2147483648"
$env:MIN_FREE_BYTES = "1073741824"
$env:FFMPEG_PATH = "C:\ffmpeg-4.4\bin\ffmpeg.exe"
$env:FFPROBE_PATH = "C:\ffmpeg-4.4\bin\ffprobe.exe"
$env:PDFINFO_PATH = "C:\Users\mizuk\AppData\Local\Microsoft\WinGet\Packages\oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe\poppler-25.07.0\Library\bin\pdfinfo.exe"
$env:GEAP_ENVIRONMENT_CONFIRMED = "true"
node server.js
```

合成入力の作成（外部API呼び出しなし、初回のみ）は `node tools/prepare-connectivity-inputs.mjs`。

パイプライン駆動用の作業スクリプト（gitignore対象）:

- `.local-validation/drive.mjs`：語彙登録 → GT登録 → 標準セット作成 → 公開
- `.local-validation/analyze.mjs`：解析のみ。`SET_ID` 環境変数で公開済みセットを再利用し、標準セットの再作成による無駄な課金を避ける

既存の公開済みセット：`55ee0da6-9d87-4dcb-9ea0-2d1dc688c610`。媒体は登録済み（標準24秒・実作業30秒の合成MP4各1本）。

## 7. 後片付けの状態

- バケットは空。全3runの媒体回収は `deleted`
- `data-real/` に実接続のrun記録・生要求・生応答が保存されている。認証ヘッダーは含まない
- モック資産（`data/`）とは分離済み

## 8. 参照

| 内容 | 位置 |
|---|---|
| 観察項目の契約 | `src/contracts.js:41-46` |
| Stage2根拠参照の契約 | `src/contracts.js:113` |
| 応答スキーマ | `src/response-schemas.js:13` |
| 接続先の組み立て | `src/settings.js:9`、`src/geap.js:39` |
| 認証 | `src/geap.js:7-16` |
| Stage2プロンプト | `prompts/stage2_text_v1.md:6` |
| 実接続の生要求・生応答 | `data-real/runs/{run_id}/` 配下の requests / responses |

## 9. 2026-09-12〜13 合成E2E疎通の完了

### 9.1 最終結果と適用範囲

利用者の完了条件である「合成入力で標準セット作成から解析Stage2まで通る」を確認した。最終セット／解析の各モデル呼出しはすべて初回HTTP 200で、契約失敗・API再試行・モックへの切替なし。解析はブラウザの「解析を開始」から実行した。

| 項目 | 実測結果 |
|---|---|
| 接続 | `tas-connectivity-test` / `global` / `https://aiplatform.googleapis.com` / `v1beta1` |
| モデル・設定 | 両Stage `gemini-3.6-flash`、返却modelVersionも同名。temperature 0、AGENTIC要求、1fps、音声なし、round18.v1 |
| 最終標準セット | `9db0c724-8cae-41b3-88de-b2aa8c9aeb37`（画面名「合成疎通 E2E・2026-09-12 v3」） |
| 標準作成run | `97ce0d36-67c8-478e-be2c-6ede0f080dd2`。unguided／guidedの固定Stage1各1回、4区間ずつ有効、代表画像12枚を生成、公開済み |
| 最終解析run | `2d7c987a-15c3-45b6-8ff2-5dc2e5163449`。`text_only` / `few_shot`、Stage1を新規生成してStage2まで `succeeded` |
| 実Stage1 artifact | `b6c66449-81ed-4333-aa9b-a2d1989a60df`。`reused:false`。旧失敗runの再利用で通し実行を代用していない |
| 入力 | 標準24秒 `8722c72e-8be7-4776-a043-2af08d112e11`、実作業役30秒 `04e35605-7c1e-458d-8478-e6bc06fda9aa`。両方ともFFmpeg生成の合成模様。登録済みの実業務動画は選択・送信していない |
| 解析結果 | 0〜30秒の1区間、「その他」`NW07`、根拠配列は空、`review_required:true`、`eligibility:unverified`。作業精度の合格を示さない |
| 処理時間 | 標準は受付→承認待ち93.625秒（API 54.959秒＋32.960秒）。解析は受付→結果確定44.173秒（Stage1 API 22.937秒、Stage2 API 13.770秒）。1試行の値であり性能保証ではない |
| 最終通し実行の使用量 | モデル呼出し4回、47,829 tokens（標準31,713、解析16,116） |
| この依頼全体の使用量 | 修正確認・途中失敗を含み10回、102,621 tokens。第4章の先行5回とは別集計 |
| 費用 | 生usageMetadataを保存。料金表未設定・請求額未取得のため `cost_status:unknown`、金額null。未取得を0円としない |

対話が中断していた間も標準作成ジョブは終了して `awaiting_approval` で保持され、媒体回収も完了していた。2026-09-13の再開後に8件の記述が合成模様・観察不足を表すことを確認し、利用者からの委任による疎通専用の確認者名で公開した。業務用のお手本として人が正解を承認したものではない。上表の標準処理時間に翌朝までの承認待ちは含めない。サーバーのジョブ中断・再試行は発生していない。

### 9.2 D-1の判断・実装と追加発見

**通常の根拠参照には `anyOf` を採用した。** [Google公式の構造化出力仕様](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output) が `anyOf` / required / maxItems をサポートしていることを確認し、実際のStage2要求でも受理された。4種のkindを個別のオブジェクトにし、それぞれの全項目を必須とする。サーバーの参照先・時刻・余剰キー検証は緩めていない。

最初の再実行 `30ed8d6b-8272-4cb4-bd30-e2db52d4a4e3` は既存Stage1を再利用し、Stage2だけで成功した。一方、新セットからの解析 `1005f5f9-f7e6-4c73-8f35-b9b8f454c6be` では、構造が正しくなった後に `ref: 入力にない観察根拠` で失敗した。この失敗と生応答を保全している。

追加失敗の実応答は `{kind:"observation",segment_id:"seg-0001",field:"objects_parts",evidence_id:"ev-0001"}`。ev-0001自体は存在するが、objects_partsはunknown／evidence_ids空であり、ev-0001は「対象物がない」という `unobserved_occlusions` の理由にだけ結び付いていた。これは項目の観察根拠としては無効で、検証による拒否は正しい。

そのため、文章入力の実区間と送信対象のお手本すべてに参照可能な項目根拠がない場合だけ、根拠配列を `maxItems:0` にする独立スキーマを追加した。モデルに作業観察の根拠を捏造させる必要がなくなる。入力の観察本文・不足理由・元の生応答は保ち、出力の修復・サーバーによるラベル代入はしない。1件でも参照可能な項目根拠がある場合と案3では通常スキーマを用いる。

| APIスキーマ版 | SHA-256 | 用途 |
|---|---|---|
| `stage2.response.v2` | `6ca6ed0fc416ab678ecf84aaa531c5979cd48aad33974fb48b5fc0e525c28ec4` | 4種の参照を分岐する通常版 |
| `stage2.no-evidence.v1` | `489665b7eb1fb64aee8b736855d895f73fd5615d9e280c425c793b2beee2ebb4` | 参照可能な項目根拠がない文章入力のみ |

出力JSONの契約名 `stage2.v1` は維持し、`versions.stage2_schema` には選ばれたAPIスキーマの版・実送信ハッシュを記録する。同じAPIスキーマ版の内容変更は版台帳で拒否する。正本仕様5.3.1・8.7も更新した。凍結済みプロンプトとmanifest、Stage1スキーマ、既存の標準・原本・失敗履歴は変更していない。

追加修正後のStage2単独確認 `2921a11b-62f3-43ff-9107-1f2e0d20aa16` も成功し、その後に9.1の新セットからの実行を通した。単独確認2回は既存Stage1の再利用で動画再送・Stage1の課金を避けた。

### 9.3 D-2〜D-4の判断

- **D-2**：今回は合成データに限定し、実測済みのglobal／同モデルを継続使用した。業務動画の国内保管・処理の要件、利用可能なモデルとの両立は未決のまま。F-2のモデル一覧観測だけから「国内で使えるモデルが将来も2種類だけ」「国内要件とGemini 3系が常に両立不能」と一般化しない。本依頼では地域別の追加モデル調査・呼出しを行っていない。
- **D-3**：保存済み生応答を再検討したが、Partに見つかったのはtextと不透明なthoughtSignatureで、processingCall／processingResult相当の確認可能な構造はなかった。この依頼の全10応答の検出件数も0。toolUsePromptTokenCountやIMAGEの使用量は処理・課金の観測として保持し、agenticの証明へ読み替えない。検出を拡張せず `agentic_unconfirmed` を維持した（文章Stage2はnot_applicable）。
- **D-4**：運用手順・実装記録・docs索引へ測定範囲を反映した。`src/settings.js` はlocation=globalなら地域接頭辞なしホストを既定にする修正とテストを追加し、GEAP_HOSTの明示指定は維持した。今回の実呼出しは明示ホストで実施し、既定値の構成は単体テストで同じURLになることを確認した。

### 9.4 実行した検証

PowerShell、リポジトリ直下。pdfinfoは第6章のPDFINFO_PATHを設定した。最初のサンドボックス内の全テストではpdfinfo起動がアクセス拒否になったため、許可された実行環境で再検証した。失敗を成功件数に含めていない。

| コマンド／操作 | 今回の結果 |
|---|---|
| `npm.cmd test` | 最終63/63成功、失敗0。`.local-validation/connectivity-tests.txt` |
| `npm.cmd run probe:self-test` | 最終 `LOCAL_TESTS_PASSED`。`tools/geap-probe/runs/1d80ce7c-cf23-4775-b904-08aa361b1b51/local-acceptance.json`。外部API不要の検証で、実Checkの合格ではない |
| `node --test test/stage2-response-schema.test.js test/geap-adapter.test.js` | 9/9成功。欠落参照・余剰項目・未知根拠・方式違反・区間外時刻の拒否、根拠なし選択、globalホストを確認 |
| `$env:SET_ID='55ee0da6-9d87-4dcb-9ea0-2d1dc688c610'; node .local-validation/analyze.mjs` | 通常スキーマのStage2単独確認成功 |
| `node .local-validation/build-connectivity-v2.mjs` → 公開 → 画面の「解析を開始」 | 追加の参照先違反を発見。失敗runは9.2に記録 |
| `$env:SET_ID='5848b3f3-632d-4fd5-be35-a5f339214778'; node .local-validation/analyze.mjs` | 根拠なしスキーマのStage2単独確認成功 |
| `node .local-validation/build-connectivity-v2.mjs v3` | 最終標準作成成功。既存の合成媒体・語彙・標準GTを使用し、モデル出力を新規生成 |
| `node .local-validation/approve-connectivity-v3.mjs` | 8記述の観察不足を確認後、疎通専用として公開 |
| ブラウザで合成30秒動画＋v3セット＋同意 →「解析を開始」 | 最終run `2d7c987a-15c3-45b6-8ff2-5dc2e5163449`。解析・結果表示・削除完了まで確認 |
| `. ./.local-validation/connectivity-env.ps1; node .local-validation/verify-connectivity-v3.mjs` | `SYNTHETIC_CONNECTIVITY_PASSED`。GT隔離監査、Stage1／2契約、IDと時刻不変、新規Stage1生成、全4試行HTTP 200、実送信スキーマハッシュ、GCS不在を検証 |
| `git diff --check`、プロンプトmanifestのハッシュ検証 | 差分の空白エラーなし、manifest適合。凍結原本SHA-256は `06bfefc4e758e54bf8b4b54714fa727e4be68cc6176bf529402fce69a9ba8db5` のまま |

作業スクリプトと詳細レポート `.local-validation/connectivity-v3-verification.json` はGit除外のローカル証跡。生要求・生応答・usageは `data-real/runs/{run_id}/` に保存し、認証ヘッダーは保存しない。料金・モデル・datasetの情報が変わるため、将来の無条件の実接続自動実行手順にはしない。

### 9.5 媒体回収

**2026-09-13 10:06:42 JSTに確認済み。** 最終標準／解析runは両方 `cleanup_status:deleted`。data-realの全削除台帳もdeletedで、先行測定分を含むGCS一時URI **7件すべて**に認証付きmetadata GETを行い404を確認した。バケットのオブジェクト一覧GETはHTTP 200、`versions=true` を含めて **0件**・次ページなし。バケット全体の一括削除は行っていない。

ローカル原本・標準画像・GT・要求／応答・結果・失敗履歴は保全。媒体が回収済みであることと、モデルのagentic発動・精度・請求額の確認は別である。

### 9.6 分析ボタンの操作性

実ブラウザでホーム→「分析の実行・見本の管理」→登録済み合成動画／標準セット選択→同意→開始を操作し、開始ボタンの無効／有効切替、処理中の開始抑止と中止ボタン、完了結果の表示を確認した。**機能として実行できるが、初見で分析を始めやすいUIとはまだ言い切れない。**

- 青い開始ボタンは押しやすく、動画・セット・同意の準備後は追加ダイアログなしで開始できる。
- 1265×712の確認画面では開始ボタンと同意欄が初期表示の下に隠れ、スクロールが必要。ホームでは実行導線が左サイドバーの小さいリンクにあり、「対象動画を選ぶ」と実解析開始の違いが分かりにくい。
- 実行画面に濃色の入力欄と白地が混在し、説明・送信先・一部の見出しが低コントラストで読みづらい。
- 登録済み動画を選んでもアップロード枠が「未選択」のまま残る。解析完了後にも「サーバーで処理を継続しています」が併記され、実行状態の説明に不整合がある。

次のUI改善では、ホームに主導線「新しい分析」、実行画面に見える位置の開始操作、入力選択表示の統一、完了文言・コントラストを優先するとよい。今回は確認結果を記録し、既存UIを変更していない。モバイル・支援技術・初見利用者での実地操作テストは未実施。

### 9.7 残る未確認事項

この完了は合成短尺の案1 Few-shot疎通に限定する。根拠なしスキーマとanyOf通常版のAPI受理は測定したが、4種類の非空根拠参照を正しく生成・採用すること、実業務の分類精度、案2／案3とZero-shotの実解析完走、画像入力の制限、agentic発動、20分性能、請求総額、業務データの所在地、実故障注入は未確認。Check 0〜11全体と3方式の適格性を合格に変更していない。アプリはlocalhostで継続起動中で、クラウドへのデプロイはしていない。
