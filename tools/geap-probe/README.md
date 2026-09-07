# GEAPプローブ — Round 18

Gemini Enterprise Agent Platform（2026年4月にVertex AIから改称）の検証用です。**Check 0〜11の実API測定はすべて未実施**。Check 7〜11の実行・採点コードを追加し、合成データで契約を確認しました。モックの成功は実測PASSではありません。

現行契約は [Few-shot仕様書 第10・12章](../../docs/2026-09-06_FEWSHOT_SPEC.md)。12.9の運用・精度ゲートは維持します。実測前に実装を進めた例外は [実装記録](../../docs/FEWSHOT_IMPLEMENTATION.md) に記録しています。

## 対応範囲

| Check | 検証内容 | 実APIの現状 |
|---|---|---|
| 0 | mediaProcessingの指定位置。旧探索コードを保持 | NOT_RUN |
| 1 | agentic＋旧9項目JSON | NOT_RUN |
| 2 | 2動画の時刻帰属。歴史的な参考測定のみ | NOT_RUN |
| 3 | 20分動画のagentic痕跡 | NOT_RUN |
| 4 | countTokens / usageMetadata | NOT_RUN |
| 5 | 最近傍による旧時刻診断 | NOT_RUN |
| 6 | 指定Proモデルのagentic痕跡 | NOT_RUN |
| 7 | 匿名固定境界、自由記述対照＋3方式×Zero/Few | NOT_RUN |
| 8 | 生のdiscover出力の結合・分裂・DP対応・oracle | NOT_RUN |
| 9 | 通常discover、5手順区分、3方式×2モード×3反復 | NOT_RUN |
| 10 | strict区間誤り、安全網の見逃し・確認負担・raw確信度帯 | NOT_RUN |
| 11 | Fewのtext / text_actual_video / text_actual_video_standard_images | NOT_RUN |

追加Checkは `extra-checks.mjs`、ネットワークを持たない採点処理は `scoring.mjs`。Check 8・10の単独実行は保存済み評価runだけを読み、APIを呼びません。Check 11は9と同じ条件の結果をrun IDで再利用します。中間条件はプローブ専用です。

## 外部APIを使わない自己検査

```powershell
npm.cmd run probe:self-test
```

`runs/{id}/local-acceptance.json` にテスト結果とコードハッシュを保存します。実測欄はNOT_RUNのままです。FFmpeg / ffprobe / PDF検証用pdfinfoが必要です。全既存テストも含める場合は `npm.cmd test`。

## 実測前の準備

1. 標準・開発・独立評価の動画を分離し、送信対象（実動画、標準動画、標準画像、標準書）と作業者の同意を確認します。
2. [アプリ運用手順](../../docs/FEWSHOT_OPERATIONS.md) に従って認証・project・location・bucket・IAM・確認したモデルIDを設定します。ローカルはgcloud、Cloud Runへ移す場合はサービスアカウントです。
3. 実接続モードで対応条件の標準セットを作成・確認・公開します。モックで作成した標準記述を実測のお手本に流用しません。
4. manifest、GT、類似グループ、観察可能性、settings、採点policyを用意します。スキーマと例は仕様12.3。パスはmanifest所在ディレクトリ基準です。
5. 予備測定後に合格基準・料金・モデル能力を確認して別版に固定します。未確定の数値に既定値を埋めません。

必要なmanifest項目は `schema_version:geap-eval-manifest.v1`、dataset_id、split（pilot/holdout）、standard_set_id、settings_ref、scoring_policy_ref、acceptance_policy_ref（未定はnull）、repetitions:3、全3方式・全2モード、casesです。

各caseはcase_id、inference:{video_id,asset_ref}、scoring_only:{gt_ref,scenario,similar_groups_ref,observability_ref}。GTは仕様12.3の全長を覆う出現ID付きJSON。scenarioはnormal/reordered/repeated/omitted/rework。GT動画ID・長さを媒体と照合します。類似グループはjob_nos・selection_reason・独立したwindows、observabilityはGT区間ID・visible/not_visible/disputed・理由・確認者を記録します。

settings_refは `GET /api/config` のsettingsと同じ形式。標準セットのStage1条件と一致させます。`MODEL_REVISION_SCOPE` を検証セッション内で固定してください。確認済みモデルIDに置き換えた上で使用します。

採点policyの最小例：

```json
{"version":"tas-eval-round18.v1","sample_hz":10,"units":{"rates":"ratio","edit":"0..100"}}
```

## Check 7〜11を実行

```powershell
$env:GEAP_CHECKS = "7,8,9,10,11"
$env:GEAP_EVAL_MANIFEST = "C:/path/to/evaluation/manifest.json"
$env:DATA_ROOT = "C:/path/to/real-app-data"
$env:GEAP_EVAL_CONSENT_CONFIRMED = "true"
$env:GEAP_ENVIRONMENT_CONFIRMED = "true"
node tools/geap-probe/probe.mjs
```

これに加え、運用手順のGEAP設定が必要です。`GEAP_PROBE_MOCK=true` を指定すると同じ経路を合成応答で実行します。実接続失敗による自動モック化はありません。

保存先は `tools/geap-probe/runs/{evaluation_run_id}/`。`GEAP_EVAL_OUT_ROOT` で親ディレクトリを変更できます。`resolved-manifest.json` に入力・GT・設定・画像・コード・プロンプト・実行順のハッシュを固定します。requests/、responses/、stage1/、stage2/、attempts.json、evaluation-records.json、scores.json、summary.json、cleanup/を保存し、認証ヘッダーは保存しません。採点用GTを含む成果物は通常入力へ送らないでください。

```powershell
# 保存済み成果物の再採点。APIも媒体アップロードも行いません。
$env:GEAP_CHECKS = "8,10"
$env:GEAP_EVAL_RUN = "C:/path/to/runs/previous-evaluation-id"
node tools/geap-probe/probe.mjs
Remove-Item Env:GEAP_EVAL_RUN
```

## 採点と判定

- 全ラベル（非作業7種を含む）を10Hzの半開区間で評価。隣接同ラベルを圧縮したEdit（0〜100）・F1と、生Stage1の構造診断を分けます。
- F1は時間順に同ラベル最大IoUのGTを選び、使用済みなら第2候補へ付け替えません。TP/FP/FNをmicro集計。MoCはGTクラスだけ、クラスIoUはGT/予測の和集合。
- Check 8は対応数最大→総IoU最大→早いIDの単調DP。内部境界は1/3/5秒で対応数最大→絶対誤差最小。結合の実質重複と厳密版、分裂、欠落・余剰、oracleの10Hz版と連続秒版を出します。
- Check 10は誤り秒が0より大きい区間を誤りとする主指標と、多数ラベルによる補助指標を別保存。分母0はnull。raw確信度は全件／強制低下なし／強制低下対象の3表、表示値は別表です。
- 構造不正は動画全体invalidとして精度0・全体確認対象。通信失敗・中断は精度N/A、実効Accでは実施済み失敗の正解フレームを0にします。未実施は実効Accの分母に入りません。
- 各反復でStage1を新規生成し、反復内のみ案1/3・Zero/Few・Check 11へ共有します。guidedは別実体です。類似グループの離れた窓を連結しません。
- 5区分のカバレッジを表示。pilotは各1本、holdoutは各3本（各区分18〜22分1本以上）が最低条件です。足りない区分を合格にはしません。
- Check 11はペアの誤→正／正→誤、MoF差、見逃し率差、根拠確認対象を保存。人の根拠監査と実運用故障・20分・費用の判定は未実施欄に残ります。全ての実接続ゲートを人が確定するまでquality_verdictはUNVERIFIEDです。acceptance_policy_refは開始時に凍結・記録します。

基準算法は [MS-TCN eval.py](https://github.com/yabufarha/ms-tcn/blob/33ed91c0c7576650a2367efc602553af4c5295b1/eval.py)（commit固定）。Round 18に従い10Hz・非作業を除外しない点・失敗評価・連続時間診断を追加しています。

## 旧Check 0〜6

`GEAP_CHECKS=0,1,2,3,4,5,6` を指定します。未指定時も従来範囲です。設定はGEAP_PROJECT、GEAP_LOCATION、GEAP_HOST（任意上書き）、GEAP_FLASH_MODEL、GEAP_PRO_MODEL、GEAP_SHORT_VIDEO_A、GEAP_SHORT_VIDEO_B（Check 2）、GEAP_LONG_VIDEO、GEAP_EXPECTED_SEGMENTS（Check 5のJSON）、GEAP_OUTです。モデルIDの推測既定値は置いていません。認証はgcloudまたは旧GEAP_ACCESS_TOKEN。tokenはレポートに保存しません。

Check 0の位置探索・旧9項目・2動画参考・最近傍境界のコードは保持しています。新スキーマや1動画構成の成立証明に代用しません。Check 2はNEEDS_HUMAN_REVIEW、4・5は測定です。痕跡なしはagentic_unconfirmedで、モデル全体の非対応や静的フォールバックを断定しません。旧チェックの元URIは利用者が管理し、プローブが原本を削除することはありません。

## 異常終了時の媒体回収

追加Checkは送信前に一時URIを台帳へ登録し、結果不明なら猶予を置きます。ローカル標準画像と媒体原本は常設です。プローブを停止した後は、同じバケット・認証設定で次を実行し、deletedまで確認します。

```powershell
node tools/geap-probe/cleanup.mjs "C:/path/to/runs/evaluation-id"
```

台帳の正確なURIとgenerationだけを対象にし、404は回収済みと扱います。削除失敗は1分→5分→30分→60分で再試行可能な日時を記録し、24時間後も打ち切りません。CLIは常駐しないため、猶予／再試行時刻後に再実行してください。通常アプリはサーバー稼働中に自動で回収を続けます。
