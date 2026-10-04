# 観察からの分析・レビュー・見本化：実装と検証報告

2026-10-05。対象は `.local/2026-10-04_VOCABULARY_REVIEW_CYCLE_IMPLEMENTATION_PROMPT.md` と承認済み設計の追補。実装場所は `C:\Users\mizuk\work\gemini-tas-demo\.claude\worktrees\ui-rebuild`。

## 到達した状態

全体＋案1で「Aのお手本なし分析 → 人レビュー保存 → 選んだレビュー区間から見本確定 → 別動画Bの独立分析 → 固定区間の見本対応」を実装した。手の動き・操作、物体・部品、工具、位置・治具、前後状態、遮蔽と不足を共通Observationから読む。名前と作業内容は自由記述。作業名一覧・識別条件・ダミー語彙・別の一覧承認操作は新フローの前提にも途中操作にも残っていない。

既存の実モデルGeapAdapterに新しい命名・対応要求を接続した。REALでも同じ受付・画面・レビュー・見本・保存履歴を使う。今回行ったのはローカル検証と認証／通信を置換したREALテストであり、実API受理・実動画品質・精度・実費・長尺性能の実測ではない。これらのゲートは未測定。

対応表と契約詳細は[追加契約](2026-10-04_OBSERVATION_REVIEW_CYCLE_CONTRACT.md)。新フロー対応は全体＋案1のみ。全体＋案2／案3／jointと分割＋案1／案2／案3／jointは新契約未対応としてUIと受付で理由を表示・拒否する。空語彙で旧処理や別方式へ戻さない。既存8組合せの処理・制限は保持し、分割／jointの実動画拒否と実験結果の編集拒否も回帰検証した。

## 追加契約と保全

| 対象 | 実装した契約・動作 |
|---|---|
| 入力 | observation-analysis-input.v1、明示label_policy observation_open.v1。語彙・識別条件はnullと未使用理由。旧入力と混在を拒否 |
| 命名 | observation-naming.v1。固定segment ID集合に仮名・作業内容・根拠・不足を返す。時刻追加や架空根拠を拒否 |
| 結果 | task-discovery-result.v1。元動画、Stage1、prompt/schema、API試行と生応答、固定区間、命名と別対応の出典・SHAを保持 |
| review | discovery-reviewed-result.v1。元結果SHA、確認者・日時、変更前後と確認範囲を不変保存。保存だけでは確認済みにしない |
| 見本 | review-derived-standard.v1。保存済みreview IDとSHA、選択区間、確認範囲から作る不変版。task_indexは実区間から派生。作成時のモデル呼出し0 |
| 対応 | task-alignment.v1。候補／見本にない作業／対応不明、未対応見本、対象・例の実根拠を別保存。1対多・多対1を許し時間二重計上を防止 |
| 送信ビュー | review-example-view.v1。確認した名称・内容と共通観察を明示投影。見本境界・時系列・GT・review原本・採点・標準時刻を除外 |
| Stage1共有 | 新目的内のZero/Fewは語彙なしstage1-cache.v2で共有可能。旧cache.v1と旧案1/3共有・guided分離は維持 |

Bの発見・命名には見本を送らず、先に独立成果物として保存してから見本対応を求める。対応失敗でもBの発見原本・生応答を保全し、全体成功とは扱わない。見本名でBの観察・仮名を上書きしない。同名だけで対応を決めず、反復・短時間作業・粒度差・不明を残す。未対応見本は欠落候補であり、欠落確定や0秒ではない。細分時間の割当はnull。

境界や観察を変えたreviewには新しい区間内の根拠検査と人の適合説明・確認を要求する。元のAI根拠は別に残す。未適合区間は見本にできない。元Stage1がdiscover由来であることをfixedと偽装しない。見本での観測時間は保存したend−startであり、ST・標準順・標準書ページは不明。

Round 18本文、round18.v1、reference/validated_prompt.md、jointの凍結本文、既存standard-set.v1/v2・stage2.v1を変更していない。旧保存データを一括変換していない。GT隔離、Stage2時刻不変、原本・中止・retry・結果不明の自動再送禁止・再起動回復・媒体回収の独立状態を維持した。

## 検証結果

| 実行・確認 | 結果と限界 |
|---|---|
| `npm.cmd test` | 最終195件合格、失敗・skipなし。既存回帰、新契約、保存故障、中止、retry、再起動、部分失敗、結果不明、見本／媒体欠落、回収失敗を含む |
| `npm.cmd run probe:self-test` | LOCAL_TESTS_PASSED。ローカル接続契約のみ。実接続の測定ではない |
| 通信置換REAL | 新builder→実GeapAdapter→応答schema検査→原本保存→review→見本→B対応を確認。認証・cloud送信・媒体操作は置換 |
| REALのHTTP配信 | health機能／起動版、配信HTML／JS、新API受付・往復が同じ実装を示すことを確認 |
| 起動口回帰 | 親からの委譲、引数伝播、子失敗コード、委譲先欠落時の遮断、旧mode／別workspace／別data root／別PID／旧版／資産不一致の拒否、同一最新版再利用、使用中ポート保全が合格 |
| 版不一致の回帰 | 隔離したソースコピーで起動後にJSを変更。healthの起動fingerprintは不変、assets_consistent=false、health以外は409になり混在配信を拒否 |
| UI往復 | 空の専用TEMP＋空きポートのMOCKで、語彙0・GTなしのA24秒→改名と内容確認→20確認範囲→保存→4区間見本→B30秒の5区間対応を操作確認 |
| UI保全 | 未保存修正がある履歴切替を拒否し入力を保持。保存済みreview／自動判定原本を選べる。空時刻の保存も拒否して入力を保持。履歴から新目的と見本を復元 |
| 画面寸法 | 1200×1000／720×1000／400×1000、入力・履歴・B結果・A結果・review・見本作成・ライブラリの計21画面。strict検査で横スクロール／はみ出し／切れ／小文字／低コントラストの違反0。代表PNGも目視確認 |
| 差分 | git diff --checkに問題なし。既存未追跡資産を保全。stage／commit／push／PR／mergeなし |

新テストは `test/discovery-cycle.test.js` の11件。命名の時刻改変・架空根拠・二重segment、不足確定、境界適合、見本SHAと例示ビュー隔離、1対多／多対1、改名時の区間ID保全、旧結果の表示adapter混入拒否も含む。結果不明の実adapterテストでは新しい命名のremote呼出しが1回だけであり、自動再送しないことを確認した。

ローカル証跡は `.local/vocabulary-cycle-tests-final.log`、`.local/vocabulary-cycle-probe-final.log`、`.local/ui-shots/vocabulary-cycle-final5/{summary.txt,report.json,*.png}`。probe証跡は `tools/geap-probe/runs/28082f64-0954-4973-80e6-15f59cc1449a/local-acceptance.json`。すべて合成・ローカルであり、精度の根拠には使わない。

撮影ツールは通常実行2回でChrome接続が切れ、撮影未完了だった。隔離MOCKへの撮影を許可した実行で初回にcheckbox欄と長いSHAの折り返しを検出し、CSSを修正した。その後のstrict検査は全画面違反0。修正後の空時刻チェックも操作検証し、最終ソースでテストと撮影を再実行した。

検証保存先は新規作成した `C:\Users\mizuk\AppData\Local\Temp\tas-cycle-ui-4mFkbN`。検証中のポートは空きを都度取得し、最終撮影は56623。再起動したのは今回起動したMOCKプロセスだけ。既存data／data-realでは起動せず、既存サーバーの再利用・停止、実認証・API送信・クラウド作成は行っていない。検証プロセスは終了時に停止した。TEMP合成データは証跡用として残し、通常のREAL保存先とは独立している。

## 元フォルダーの起動バッチで目視確認する手順

1. `C:\Users\mizuk\work\gemini-tas-demo\start-app-real.bat` を起動する。親にはscripts/start-real.ps1がなく、保全した既存バッチが実装worktreeへ委譲する。新機能は常時有効で、MOCK限定の機能flagはない。既存のreal-connection.env（なければ既存legacy設定）と認証・project・権限・環境確認値を使う。未確認の環境値を自動設定しない。
2. ポートと保存先は明示した環境変数PORT／DATA_ROOTを優先し、次に接続設定、未指定なら4173／worktree内data-real。起動端末の表示で実際の値を確認する。別保存先で試す場合は起動前に両方を明示する。今回のTEMP検証データをREALとして起動する必要はない。
3. 使用中ポートで旧版・別checkout・別保存先・MOCK・PID／資産不一致ならバッチは失敗し、そのサーバーを停止しない。稼働中サーバーの履歴で処理中runと媒体回収状態を確認する。終えてよいサーバーであることを確認したうえで、その起動端末でCtrl+Cし、同じ親バッチを再起動する。正体不明のプロセスは強制終了せず、別PORTと別DATA_ROOTを選ぶ。同一最新版・同一REAL・同一保存先・PID一致の場合だけ既存サーバーを使う。
4. 「分析の目的」は既定の「観察から作業内容を分析（一覧の準備不要）」、動画の分割方式は「動画全体を処理」、分析方式は「案1：観察記録から判定」。作業名一覧・識別条件を作成する操作は不要。「お手本なしで分析」を選んで動画Aを登録／選択する。
5. 作業者の同意、Google Cloudへの送信先、保存先を確認し、同意欄をチェックして分析を開始する。登録はPC内保存で、分析開始時に実動画を送る。実測に進む場合は[運用手順](FEWSHOT_OPERATIONS.md)の実接続・媒体回収確認に従う。
6. 結果で手の動き・物体・位置・前後状態と不足・根拠を映像と照合する。「確認した名称」「確認した作業内容」は自由に入力する。必要ならObservation JSON、境界、人の根拠説明を修正する。確認者を入力し、実際に確認した範囲だけチェックして「レビューを保存」。境界・観察変更では適合根拠が必要。未保存入力は見本作成に使えない。
7. 「このレビューから見本を作成」で見本名・確認者を入力し、含める保存済み区間を選んで「選んだ区間で見本を確定」。全区間の確認を要求する操作ではなく、選んだ区間に5項目の確認を要求する。ST等の空欄を埋める必要はない。原本・reviewは残り、同じ内容へのモデル再送はない。
8. 「新しい分析」で別動画Bを登録／選択し、「お手本と照合」で作成した見本を選ぶ。同じSHAの動画は拒否する。Bについても送信同意を確認し開始する。Bの観察・仮名が保持され、見本への候補・対応不明・見本にない作業・未対応見本が別表示される。
9. 実行履歴からA／Bの結果と保存reviewを再表示する。媒体回収表示を確認し、結果完了でも一時媒体が削除失敗／結果不明／保護中なら別状態として扱う。元動画が欠落した見本はライブラリで理由を表示する。原本・保存済みreview／見本／結果を削除して解決しない。

親とworktreeのstart-app-real.batは既存内容のまま、開始／終了SHA256は双方 `7A8824FC00DC2E7C49C3DE17AD8807C889C72CBC080A9116941CCF51B60B7942`。親バッチの変更前後差分は0。変更したのはworktree側の版検査helperとアプリで、親へ本体・docs・設定・データをコピーしていない。

## 変更ファイルと開始／終了比較

| 区分 | ファイル |
|---|---|
| 新しい実装 | src/discovery-contracts.js、src/discovery.js、src/implementation.js、public/discovery-review.js、scripts/implementation-fingerprint.mjs |
| 新prompt | prompts/observation-cycle-naming.v1.md、observation-cycle-alignment.v1.md、observation-cycle.v1.json |
| 接続・保存 | src/pipeline.js、src/inputs.js、src/routes.js、src/mock-model.js、server.js |
| 画面 | public/analysis.html、analysis-state.js、fewshot.js、styles.css |
| 起動 | scripts/start-real.ps1。親／worktreeのbatは変更なし |
| 検証 | test/discovery-cycle.test.js、start-real.test.js、glossary.test.js、tools/ui-shots/main.mjs、scenarios.mjs |
| 文書 | 本報告、追加契約、docs/README.md、USER_GUIDE.md、FEWSHOT_OPERATIONS.md、DEVELOPMENT.md |

実装worktreeのbranchは開始／終了とも `feat/ui-stage5`、HEADは `4150ad626ec3c3a911fd86035b75ebae03dd64c6`。開始時のgit status --shortは既存未追跡 `?? docs/ui-mock-2026-10-03/` のみ。終了時は同資産に加えて上表の18 tracked変更・11新規ファイル（契約・報告を含む）。削除・stageなし。既存 `.local/` の指示・設計・画像・検証資料、動画・認証設定・保存データは保全した。今回作った無関係なPython bytecodeだけ除去した。

親branchは `chore/0924-followup`、HEADは `a893e3c7fcf0c32206ec22b1cd4f4a44853b2eb6`。親の開始／終了statusは同一で、開始時から以下の変更があった。本作業では編集していない。

```text
 M .gitignore
 M AGENTS.md
 M README.md
 M docs/CLAUDE_REVIEW_HANDOFF.md
 M docs/DEVELOPMENT.md
 M docs/README.md
 M docs/work-measurement.md
 M package.json
 M scripts/work_measure.py
 M start-app-real.bat
 M tests/test_work_measure.py
 M tools/geap-probe/README.md
 M tools/geap-probe/self-check.mjs
?? .rgignore
?? docs/2026-09-19_JEV_TAS_PROPOSAL.md
?? docs/2026-10-02_GEMINI_FACTORY_TAS_REVIEW.md
?? docs/2026-10-03_HARNESS_AUDIT.md
?? scripts/validate.py
?? tests/test_validate.py
```

継続計測IDは `vocab-cycle-20261004-b1`。開始・pruning／repo_mapイベント・終了をwork-measure CLIで記録。checkpointは未使用。取得できない文字数・モデル設定・tokenはunknownのまま扱う。画面修正の手戻りをyesと記録し、測定欠落を0扱いしない。

## 継続する場合の引継ぎ

目的・実装の必須範囲は完了。次の独立した作業は利用者による実環境の目視確認と、承認済み媒体・環境での実API／品質測定。入口は親start-app-real.bat、仕様は追加契約とRound 18／運用手順。ローカル試験成功を実測ゲート合格へ読み替えない。未レビュー生見本の直接解析、原因別再解析、実動画の分割／joint、正式名称registry、専用固定境界再観察は未実装のまま。


## 独立レビュー指摘2件の修正と再検証（2026-10-05）

上記の初回実装・検証記録を履歴として残し、今回の判定はこの節に記録する。独立レビューで再現した2件を修正し、実差分・新旧契約・schema・prompt・保存・retry・UI・起動口・テストを再レビューした。今回の範囲で公開を止める不具合・要件違反・重要な未確認事項は見つからなかった。実API受理と実動画品質は許可範囲外の未測定のままで、実測合格ではない。

- 命名根拠：validateNamingの参照元をtask自身の固定区間に限定。別区間の実在根拠や同じevidence_id文字列を拒否し、自身の有効な根拠は受理する。observedの根拠必須・特徴不足の断定禁止、uncertain／unknownの不足保持は維持。自動補完・根拠付替え・Bの見本名上書きは行わない。
- 資産検査：起動時のfingerprint取得は厳格なまま固定。実行中の再検査だけ読取例外を不一致として処理する。healthは固定fingerprintとassets_consistent=falseを返し、他の配信は409。ジョブ・回収のライフサイクル処理は変更していない。

| 検証 | 今回の結果 |
|---|---|
| 修正前の追加回帰 | 根拠の区間交差をvalidatorが受理、MOCK／通信置換REALで成功、資産欠落で子サーバー接続切断を再現。失敗4、起動時欠落拒否1件は合格 |
| 命名回帰 | 自身の根拠受理、同一ID／別区間拒否、別区間だけにある実在ID拒否、根拠なしobserved拒否、特徴不足拒否、正当なuncertain／unknown保持。サービス経路はfailed／INVALID_DISCOVERY、Stage1と生応答を残しdiscovery／alignment／resultを確定しない |
| 資産回帰 | 独立子プロセスとTEMPコピーでpackage.json退避、EACCES故障注入、ディレクトリへの一時置換による実読取エラー、復元、読取可能なHTML改変を確認。同一PID・固定fingerprint・health応答維持、非healthのUI／APIは409。起動時欠落はENOENTで拒否 |
| npm.cmd test | 200件合格、失敗・cancel・skipなし、終了コード0（修正後状態で実行） |
| npm.cmd run probe:self-test | LOCAL_TESTS_PASSED、終了コード0。実測状態の変更なし |
| git diff --check | 正常、空白エラーなし |
| UI操作 | 一覧0件でA24秒→自由名review2版→4区間不変見本→B30秒5区間。Bの独立仮名、不明・未対応見本保持を確認 |
| 入力保全 | 未保存で結果／レビュー履歴切替を拒否。開始秒空欄・サーバー保存故障でも入力保持。故障解除後保存、AI原本／旧review／最新reviewを切替確認 |
| 画面検査 | 1200×1000、720×1000、400×1000の7シナリオ＝21画面。撮影21、省略0、エラー0、strict違反0。代表画像目視確認 |
| 互換性・起動口 | 全テストで旧8組合せ、Stage1共有、時刻固定、GT隔離、凍結prompt、旧データ、snapshot継承、結果不明の自動再送禁止、回収独立状態、同一最新版再利用／旧版・版不一致拒否を確認 |

新フローは全体＋案1のみ。実API、実動画送信、クラウド作成、実費、品質・精度、長尺性能は未測定・未実施。REAL検証は認証・通信・クラウド操作を置換した。新命名／対応schema・promptは今回の2件の修正で変更しておらず、round18.v1・reference/validated_prompt.md・jointの凍結本文・旧schemaも変更していない。

検証用子プロセスのTEMP後始末で、終了前にcwdを削除するhelperの順序がEBUSYになった。終了後の削除へ修正し、資産テスト単独と全200件の再実行で解消。初回関連テスト／診断実行は停止し、その結果を合格へ読み替えていない。画面検査の初回sandbox実行はChrome接続切断で終了コード3。専用MOCKのみを対象とする権限付き再実行は終了コード0、21画面違反0。GitHubの読取は通常sandboxで通信不可だったが、権限付き読取で確認した。自動承認による拒否はない。

証跡（全てGit対象外）：.local/codex-fix-red-20261005.log、codex-fix-related-20261005.log、codex-fix-assets-diagnostic-20261005.log、codex-fix-tests-20261005.log、codex-fix-probe-20261005.log、codex-fix-ui-20261005.log、codex-fix-ui-retry-20261005.log、ui-shots/codex-obs-fix-20261005-retry/。probe証跡はtools/geap-probe/runs/dddeb555-cb68-48ab-86cc-09ed2412a667/local-acceptance.json。

操作用MOCKは空の専用TEMP tas-codex-fix-ui-LqHysS、空きポート56230、今回作成したPID37952のみ使用。故障markerも同TEMP内だけ。資産欠落・改変はtas-assets-regression-*の隔離コピーだけで試験し、worktreeや親の実ファイルは削除していない。

開始はfeat/ui-stage5、HEAD 4150ad626ec3c3a911fd86035b75ebae03dd64c6、tracked変更18・実装新規11・既存未追跡docs/ui-mock-2026-10-03/、stagedなし。親はchore/0924-followup、HEAD a893e3c7fcf0c32206ec22b1cd4f4a44853b2eb6、既存変更13・未追跡6。親の変更・既存.local・モック・動画・保存データ・認証設定を保全し、親start-app-real.batは変更していない。親／worktreeバッチSHA256は双方7A8824FC00DC2E7C49C3DE17AD8807C889C72CBC080A9116941CCF51B60B7942。

公開先確認：originはgekkoga226/gemini-tas-demo、旧PR #15は2026-10-04にmainへmerge済み、既存open PRなし。最新origin/mainは7c0dff9で開始HEADを包含し、開始HEADとのファイル差分なし。新しいcodex/作業branchからmain向けに今回の往復実装と2件修正だけを公開する。commit・PR識別子と終了statusはチャットの完了報告で確認する。mergeは行わない。

継続計測ID：obs-fix-20261005-01。開始・終了をwork-measure CLIで記録する。親バッチからの実環境確認手順は本報告の既存手順とUSER_GUIDE「一覧を準備せず、観察から分析して見本を作る」に従う。既存サーバーの版不一致時は実行・回収状態を確認し、その端末で利用者がCtrl+C後に起動し直す。実データでの自動再起動・再送は行わない。
