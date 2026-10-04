# 観察からの分析・レビュー由来見本の追加契約 v1

2026-10-04の承認設計に対する追加実装。Round 18本文、round18.v1、reference/validated_prompt.md、jointの凍結本文、standard-set.v1/v2、stage2.v1は変更しない。旧保存データの一括変換は行わない。

## 適用範囲と入力

新しい製品目的は「Aをお手本なしで分析→結果をレビュー→保存済みreviewから見本確定→別動画Bをその見本へ対応付け」。独立した作業名一覧・識別条件の準備は全工程で不要。

`observation-analysis-input.v1`の受付は既存POST /api/analysis-runsに`label_policy: observation_open.v1`を明示する。既定UIはこの目的。APIで目的未指定の旧入力は従来の閉語彙契約を維持する。whole＋text_onlyのみ新契約へ接続する。zero_shotでは見本なし、few_shotでは`reviewed_standard_id`必須。旧standard_set_id、語彙参照、識別条件参照、旧比較セッションの混在を拒否する。vocabulary/discriminatorsはnullと未使用理由をsnapshotと結果へ保存する。ダミー語彙やapproved_byは作らない。

対象媒体・同意・環境・モデルを確認する。見本と対象の動画SHAが等しい場合は受付しない。評価GTや未知の入力項目も拒否する。見本ID・content SHA・review-example-view.v1の内容とSHA・対応版・新prompt manifest SHA・起動時実装fingerprintをsnapshotへ固定する。

| 二軸の組合せ | 新しい往復 | 従来経路 |
|---|---|---|
| 全体＋案1 | 対応。MOCKとREAL adapterへ接続 | 閉語彙Zero/Fewを保全 |
| 全体＋案2 | 未対応。補助情報を使うguided新契約が必要。空語彙で案1へ戻さない | 確認済み語彙・guided資産を使う旧方式 |
| 全体＋案3 | 未対応。画像確認・命名／対応の映像契約が必要 | 案1との実Stage1共有を保全 |
| 全体＋joint | 未対応。独立した自由命名joint契約が必要 | 音声なし合成MOCK限定 |
| 分割＋案1 | 未対応。跨チャンク名称・review・対応契約が必要 | 音声なし合成MOCK限定 |
| 分割＋案2 | 未対応。guidedと跨チャンク契約が必要 | 音声なし合成MOCK限定 |
| 分割＋案3 | 未対応。画像と跨チャンク契約が必要 | 音声なし合成MOCK限定 |
| 分割＋joint | 未対応。自由命名jointと統合review契約が必要 | 音声なし合成MOCK限定、複数core継ぎ目は未解決 |

## 推論・結果・保存

Stage1はround18.v1のunguided discoverとobservation.v1をそのまま使う。operation、objects_parts、tools_held、work_location_fixture、前後状態、根拠、遮蔽、不足を保全する。閉語彙前処理は挟まない。語彙なしのキーはstage1-cache.v2で未使用語彙・条件の版とSHAをnullにする。旧cache.v1へ混ぜない。新目的内のZero/Fewは同じキーと実artifactを共有でき、明示artifact指定は入力署名・SHA・モデル・prompt等を検査する。旧案1/3共有・guided分離は従来どおり。

`observation-naming.v1`は固定ID集合にproposed_title、action_description、knowledge_status、reason、missing_information、evidence_refsを一度ずつ返す。根拠参照のsegment_idは命名task自身の固定区間に一致し、その区間の項目と根拠IDに実在することが必要。同じevidence_id文字列が別区間にあっても区別する。時刻・未知キー追加、ID不一致、別区間からの根拠借用、実在しない項目根拠、特徴不足をobservedへ確定する応答を拒否する。observedには自身の区間の有効な根拠を要求し、応答の自動補完・根拠の付け替えは行わない。時刻はStage1の値を保持する。名称はAIの仮名で、正式registryへの登録ではない。

`task-discovery-result.v1`は元動画SHA、Stage1 ID/SHA、独立命名応答・prompt/schema版、各区間・作業種別ID、実行設定・全API試行・生応答参照、別alignmentとSHA、使用量・費用不明・cleanupを保存する。`discovery.json`、`alignment.json`、`result.json`は不変。モデルの返却版・痕跡は各attemptとStage1原本にも残る。新段階もGeapAdapter.callを通し、REALで既存UI・保存・review・見本を使う。ローカルMOCKは合成Observationから説明・対応を生成し、実映像を解析しない。

`task-alignment.v1`は対象segment_ids集合と見本example_ids集合を関係で表す。candidate、reference_unmatched、uncertainと根拠・不足を記録する。1対1・1対多・多対1を許し、対象区間の重複計上を拒否する。候補には対象と見本の実在する項目根拠が必要。同名だけで対応しない。未参照見本をunmatched_example_idsに残し、欠落候補と表示する。0秒・欠落確定・細分時間配分を出さず、time_allocationはnull。第k出現同士の旧比較は新結果に適用しない。

通常の見本送信はreview-example-view.v1だけ。例の不透明ID・確認した名称／作業内容と共通Observationを送り、evidenceはID・source・descriptionだけにする。元時刻・順序・source run／review・原本動画・作成GT・採点・STは送らない。対象の命名は見本を入力しない別呼出しで先に保存し、その後に対応する。対象の仮名・観察を見本名で上書きしない。

## 人レビューと見本

`discovery-reviewed-result.v1`を既存POST /analysis-runs/{id}/reviewsで分岐する。元result SHA、review IDとcontent SHA、Stage1出典、編集者・日時、区間ごとの変更前後・確認範囲を不変保存する。AI原本と生応答は変えない。名前、task_type_id、segment_idを区別し、改名で出現IDは変わらない。同名で作業種別を自動統合しない。人が反復を同じ作業種別へ合わせた場合は変更履歴へ残す。

UIはreviewの直接入力を保存時に一括検証する。独立した「区間へ反映」待ちを作らない。不正JSON・時刻・根拠は保存を止め、入力を維持する。保存中の新しい入力はdirtyを残す。未保存／保存中は見本確定と履歴結果の切替を拒否し、閉じる際も警告する。履歴から保存済みreviewまたはAI原本を明示選択できる。単なる保存ではconfirmed_fieldsを増やさない。

確認範囲はboundaries、title、action_description、observation、evidence。人のhuman_evidence_noteをAI原本のai_original_evidenceから分離する。境界変更に対して元Observationを採用するには新しい区間内の根拠検査を通し、人の適合説明と境界・観察・根拠確認が必要。未適合を見本として確定できない。観察修正も人の根拠確認を要求する。専用固定境界再観察や画像生成は本版に含めない。

`POST /api/reviewed-standards`はsource_run_id、review_id、review_sha256、segment_ids、name、confirmed_byを受ける。未保存review・SHA不一致・確認不足・元artifact不一致を拒否し、`review-derived-standard.v1`をreviewed-standards/{id}/standard.jsonに不変保存する。元run/result/review/video/Stage1 SHA、例ID、作成規則、確認者・日時・範囲を追跡する。レビュー済み実区間からtask_indexを派生し、別の一覧操作は要求しない。discover由来をfixedと偽装しない。区間・観察不変なら元artifactを参照しモデル呼出し0。見本観測時間はend−start、ST・standard_order・page_numberはnull。

後日のreview保存は既存見本版やBのsnapshotを変えない。見本・媒体欠落は理由付きで表示し、保存済み結果を消さない。見本が欠落した新実行／retryは停止する。見本動画が欠落しても記述・出典は残り、案1は見本の文章のみを使う。

## 故障・起動・検証境界

既存ジョブの中止・結果不明の自動再送禁止・排他確定・retry・媒体回収台帳を継承する。新resultも起動回復でSHAを検査する。retryは元snapshot・見本版を継承し、有効なStage1を再利用する。命名成功／対応失敗はdiscovery.jsonと生応答を残し全体成功にしない。結果成功と回収失敗は独立状態。

healthのimplementation.fingerprintはsrc/public/prompts/server.js/package.jsonの起動時バイトから一度だけ取得する。ディスク変更、起動後の対象欠落・読取不能・置換中の読取失敗ではassets_consistent=falseとし、healthは固定した起動fingerprintを返し、health以外の配信を409で止める。HTTP要求によってプロセス・稼働中ジョブ・媒体回収を中止／再起動／再送しない。起動時から必要資産が欠ける場合は引き続き起動を拒否する。REAL helperはworkspace、data root、PID、modeに加えて版・機能・資産一致を検査する。不明な使用中ポートを停止せず、安全な手動再起動を案内する。元起動バッチはhelperのある指定worktreeへ委譲する既存構造を維持する。

ローカル検証と通信置換REALテストは実API受理・実動画の品質・精度・費用・長尺性能を測定しない。未測定ゲートは未測定のまま扱う。検証記録と実際の操作手順は[実装・検証報告](2026-10-05_OBSERVATION_REVIEW_CYCLE_REPORT.md)。
