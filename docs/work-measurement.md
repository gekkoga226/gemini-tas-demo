# 継続計測（開発作業のみ）

`scripts/work_measure.py` は計測値だけを `.work-measure/<work-id>.json` に保存する。3リポジトリ共通の schema version 1。`.work-measure/` は Git 管理外。作業ID・モデル・作業種別・比較群には短い英数字の識別子だけを使い、課題文や機密値を入れない。

```powershell
python scripts/work_measure.py start task-001 --model gpt-6-sol --reasoning medium --work-type code-review --comparison-group routine
python scripts/work_measure.py event task-001 pruning --calls 1 --display-chars 1200 --rereads 0 --reread-chars 0
python scripts/work_measure.py end task-001 --success yes --rework no --strategy-status checkpoint=unused --strategy-status repo_map=unused
python scripts/work_measure.py summary
```

作業単位ごとに `start` を1回、`end` を1回実行する。施策を使うたびに `event` を実行し、`pruning`、`checkpoint`、`repo_map` を別々に記録する。`calls` は施策の実行回数、`display-chars` はモデルに表示された出力の UTF-16 code units 数、`rereads` と `reread-chars` は再読・復元の回数と表示文字数。追加説明や原文は保存しない。取得できない値は数値の代わりに `unknown` を指定する。集計では既知の合計と欠測件数を別々に表示する。

終了時に未使用と確認できた施策だけ `--strategy-status <name>=unused` を指定する。取得を試みたが記録不能なら `unavailable`。確認していない場合は既定の `unmeasured` を残す。`used` の施策には終了時の状態指定をしない。作業成功・手戻りは `yes` / `no` / `unknown` を明示する。比較条件（commit、開始・終了時の作業ツリー状態、モデル、推論設定、作業種別、比較群）は施策や成果と別項目に保存する。

日時、リポジトリ名、commit、作業ツリー状態はCLI実行時に自動取得する。施策の実行、出力文字数、成功、手戻りは自動検知しない。通常の `rg`、ファイル読取、別ツールによる検索や復元では自動記録されず、CLIを呼ばない作業も捕捉できない。AGENTS.md の指示だけでは実行を保証できない。セッション別 input tokens と cache 内訳は信頼できる取得経路がないため常に `unknown` とし、文字数から tokens や費用を換算しない。

比較時は同種の作業、モデル・推論設定、commit、作業ツリー状態を揃え、施策ごとの使用状況・表示文字数・再読と、作業成功・手戻りを別々に見る。欠測をゼロ扱いしない。過去の pruning 試行は節約効果の証明として使わず、P03 の採点根拠の未確認点も維持する。生ログ、検索原文、プロンプト、会話全文、秘密情報、運用データは入力・保存しない。
