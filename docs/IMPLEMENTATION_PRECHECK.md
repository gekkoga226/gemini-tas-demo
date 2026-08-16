# 実装着手前 小規模疎通記録（SPEC 18.1）

- 実施日: 2026-08-15
- 実施範囲: テキストのみ。実動画・実PDFは送信していない。
- 認証情報: `GEMINI_API_KEY` が実行プロセスに設定されていることだけを確認。値は表示・保存・ログ出力していない。
- API方式: Gemini Interactions API REST、`x-goog-api-key`、`Api-Revision: 2026-05-20`。
- 結果: **部分成功。実装着手条件は未達。**

## 確認結果

| 確認項目 | 結果 | 内容 |
|---|---|---|
| API認証・候補モデル識別名 | 成功 | `models.list` はHTTP 200。候補3種すべてが利用可能と返った。 |
| モデル入力上限 | 成功 | 3候補すべて `1,048,576` tokens。 |
| 公式出力上限 | 成功 | 3候補すべて `65,536` tokens。実装設定値は `min(65536, 公式上限)` のため `65,536`。 |
| 検証済みプロンプトの実トークン数 | 成功 | `countTokens` 結果は3候補すべて `584` tokens。 |
| 正式9項目JSON Schemaの受理 | 成功 | 配列の要素をオブジェクトとし、正式9項目を全required、`duration_seconds` は整数、その他は文字列とした最小Schemaで、3候補すべてinteraction作成がHTTP 200。 |
| background execution開始 | 成功 | 3候補すべて `background=true` の作成がHTTP 200、初期状態は `in_progress`。 |
| background状態取得（GET polling） | **失敗** | `GET /interactions/{id}` がHTTP 403、`permission_denied`。 |
| background cancel | **失敗** | `POST /interactions/{id}/cancel` がHTTP 403、`permission_denied`。 |
| interaction記録削除 | 成功 | 各テスト後に `DELETE /interactions/{id}` は成功。IDは保存していない。 |

## 失敗の原因・影響・再試行可否

- 直接確認できた原因は、API応答の `permission_denied`（APIキーが対象リソースへの権限を持たない扱い）までである。APIキーの値やプロジェクト設定を推測して原因を断定していない。
- `POST /interactions` は成功しているため、認証全体・モデル識別・Schema受理・background開始までは確認できた。
- ただし、状態取得とcancelができないため、MVPで必要な約300秒の処理待機、終端状態の追跡、中止操作を確認できない。動画・PDF送信へ進む前に解決が必要である。
- 再試行は可能。APIキーの種類・関連プロジェクトのInteractions API利用権限を確認した後、同じテキストのみのGET/cancel確認を再実施する。現時点でAPIキーや実データを変更・追加投入する判断はしていない。

## 実装判断

この記録時点では第1ゲートを完了扱いにしない。`docs/DESIGN.md` のbackground polling・cancel前提を未確認のまま、推測で実装へ進まない。

## 参照した公式資料

- https://ai.google.dev/gemini-api/docs/interactions-overview
- https://ai.google.dev/gemini-api/docs/background-execution
- https://ai.google.dev/api/interactions-api
- https://ai.google.dev/api/tokens
- https://ai.google.dev/gemini-api/docs/api-errors
- https://ai.google.dev/gemini-api/docs/models

## 引き継ぎ後の追加確認（2026-08-15）

### 実施条件

- テキストのみ。実動画・実PDFは送信していない。
- `GEMINI_API_KEY` は実行プロセスに設定されていることだけを確認した。値は検索・表示・保存・ログ出力していない。
- テストinteractionのIDは表示・保存・記録していない。各テスト後に `DELETE /interactions/{id}` を実行した。
- 基本条件は `POST /v1beta/interactions`、`x-goog-api-key`、`Api-Revision: 2026-05-20`、`background=true`、`store=true` とした。

### 追加実測結果

| 確認項目 | 結果 | 内容 |
|---|---|---|
| background interaction作成 | 成功 | `gemini-3.1-pro-preview`、`gemini-3.5-flash`、`gemini-3.6-flash` の各候補でHTTP 200、初期状態は `in_progress`。長めのテキスト要求でも同じ結果。 |
| 実行中interactionの通常GET | **失敗** | `GET /v1beta/interactions/{id}` は、実行中状態でHTTP 403、`permission_denied`。 |
| 実行中interactionのcancel | **失敗** | `POST /v1beta/interactions/{id}/cancel` は、実行中状態でHTTP 403、`permission_denied`。3候補すべてで再現。 |
| interaction削除 | 成功 | `DELETE /interactions/{id}` はHTTP 200。 |
| revision有無の影響 | 改善なし | `Api-Revision` の有無を変えても、通常GET/cancelの403は変わらなかった。 |
| APIキーの渡し方の影響 | 改善なし | `x-goog-api-key` とクエリの `key` を比較しても、通常GET/cancelの403は変わらなかった。キー値は出力していない。 |
| `v1`経路 | 使用不可 | `POST /v1/interactions` はHTTP 400、`invalid_request`。現テスト条件では代替経路にならなかった。 |
| `stream=true` GET | 代替確認のみ | `GET /v1beta/interactions/{id}?stream=true` はHTTP 200で初期状態を返したが、SSE接続を待機する経路であり、通常の非ストリームGET pollingの403を解消した証拠ではない。 |

### 切り分け結果

- PowerShellの初回確認では、GETへ空のBodyを付けるクライアント側エラーも発生した。GETのBodyを分離した再試験では、サーバー応答として通常GETの403を再現した。
- 実行中状態では通常GETとcancelが403で、完了後は通常GETが200になるため、URLの単純な誤りではなく、実行中interactionの取得・中止に対するAPIキー／関連Google Cloudプロジェクトの権限、またはAPI提供側の状態が候補である。ただし、現時点で原因を断定しない。
- `permission_denied` は公式APIエラー上、APIキーが対象リソースへの権限を持たない場合のコードである。Standard keyとAuthorization keyの種別、関連プロジェクト、Generative Language APIの制限・利用権限を確認する必要がある。
- 既存ブラウザの認証状態を確認するためAI Studioへ読み取り専用で接続を試みたが、ログイン画面であり、APIキーの入力・表示・変更は行っていない。OAuth/ADCもこの環境には設定されていない。

### ゲート判定と次の確認

この追加確認でも、第1ゲートは**未達**である。実行中interactionについて通常GET pollingとcancelが成功していないため、実装へ進まない。

次回は、ユーザーが管理するGoogle AI Studio／Google Cloudプロジェクトで、次を確認した後に同じテキスト専用試験を再実施する。

1. 使用中キーの種類（Standard keyまたはAuthorization key）と、対象プロジェクトの一致。
2. キーのAPI制限・アプリケーション制限、Generative Language APIの有効化、Interactions API利用権限。
3. 必要な場合は、ユーザーが新しいAuthorization keyを安全に環境変数へ設定した後、値を表示せずにGET pollingとcancelを再確認する。

確認が成功するまで、`docs/DESIGN.md` に従うMVP実装、依存導入、コミット、push、PR作成は行わない。

## 再試験結果（2026-08-15）

同じ実行プロセスの `GEMINI_API_KEY` を使用し、値を表示・保存せず、実動画・実PDFを送信しない条件で再試験した。

| 確認項目 | 結果 |
|---|---|
| `gemini-3.1-pro-preview` のbackground作成 | HTTP 200、初期状態 `in_progress` |
| 実行中interactionの通常GET | HTTP 403、`permission_denied` |
| 実行中interactionのcancel | HTTP 403、`permission_denied` |
| テスト後のinteraction削除 | HTTP 200 |

第1ゲートは引き続き未達であり、実装へ進まない。APIキーの種類・関連プロジェクト・キー/API制限・Interactions API利用権限をユーザー管理環境で確認または変更した後、同じテキスト専用条件で再確認する。

## 新規キー設定後の再試験（2026-08-15）

ユーザーが新しく作成したキーを `GEMINI_API_KEY` 環境変数へ設定した後、値を表示・保存せず、実動画・実PDFなしで再試験した。

| 確認項目 | 結果 |
|---|---|
| 環境変数の存在 | 設定済み（値は非表示） |
| background interaction作成 | HTTP 200、初期状態 `in_progress` |
| 実行中interactionの通常GET | HTTP 403、`permission_denied` |
| 実行中interactionのcancel | HTTP 403、`permission_denied` |
| テスト後のinteraction削除 | HTTP 200 |

新規キーでも第1ゲートは未達。API制限をGemini APIだけにしたことは確認できたが、実行中interactionのGET/cancel権限は改善していない。キーのAuthorization key／Standard key種別、関連サービスアカウント、プロジェクト側のInteractions API利用権限を追加確認する。

## ユーザー申告Authorization key設定後の再試験（2026-08-15）

ユーザーがAuthorization keyとして発行した新規キーを `GEMINI_API_KEY` へ設定した後、値・interaction ID・実動画・実PDFを扱わずに再試験した。各試験後にinteraction削除リクエストを実行した。

| モデル | 作成 | 実行中通常GET | 実行中cancel |
|---|---|---|---|
| `gemini-3.1-pro-preview` | HTTP 200、`in_progress` | HTTP 403、`permission_denied` | HTTP 403、`permission_denied` |
| `gemini-3.5-flash` | HTTP 200、`in_progress` | HTTP 403、`permission_denied` | HTTP 403、`permission_denied` |
| `gemini-3.6-flash` | HTTP 200、`in_progress` | HTTP 403、`permission_denied` | HTTP 403、`permission_denied` |

環境変数は設定済みであることのみ確認した。新キーの実際の種別・紐付くサービスアカウントは、APIキー値を表示せずにこの実行環境からは確認できない。第1ゲートは引き続き未達であり、実装へ進まない。

## 無料枠での検証モデル方針（2026-08-15、ユーザー指示）

- 課金設定を行わず、Gemini APIの挙動確認はFree Tierで利用可能なFlash系モデルのみで行う。
- 無料枠での第1ゲート対象は `gemini-3.5-flash` と `gemini-3.6-flash` とする。`gemini-3.1-pro-preview` はFree Tier対象外のため、課金なしでは検証対象にしない。
- この方針はAPIの非同期処理・通常GET polling・cancelの挙動を検証するためのものであり、Proモデル固有の出力品質・動画/PDF解析品質を代替検証するものではない。
- モックの本番想定モデルは `gemini-3.1-pro-preview` のまま維持する。実データを含むProモデル検証は、別途の課金設定およびユーザー明示許可後にのみ行う。

## Authorization key確認後の原因確定試験（2026-08-15）

添付画面により、使用中のキーがサービスアカウントへバインドされたAuthorization keyであること、API制限がGemini APIのみであること、対象プロジェクトが一致することを確認した。環境変数については、実行中プロセスとMachineスコープの値が同一であることだけを比較し、値自体は表示・保存していない。

無料枠の `gemini-3.5-flash` と `gemini-3.6-flash` を使い、テキストだけで再試験した。

| 確認項目 | 結果 |
|---|---|
| background interaction作成 | HTTP 200、`in_progress` |
| 作成5秒後の通常GET | HTTP 403、`permission_denied` |
| 実行中の `/cancel` | HTTP 403、`permission_denied` |
| `:cancel` 形式 | HTTP 404。現行設計では `/cancel` が正しい |
| 完了10秒後の通常GET（同一キー・同一モデル） | HTTP 200、`completed` |
| interaction削除 | HTTP 200 |
| Google公式Python SDKでの再現 | 作成は成功し、5秒後の `interactions.get` は同じHTTP 403 |

### 原因判定

原因は、ユーザーのAuthorization key作成・環境変数設定・API制限・課金設定ではなく、Gemini Interactions API提供側で、実行中interactionに対する通常GETとcancelの認可判定が不整合になっていることと判断する。

根拠は次のとおり。

- 同じAuthorization keyで作成と削除は成功する。
- 同じAuthorization key・同じGET URLが、interaction完了後にはHTTP 200になる。
- REST直呼びとGoogle公式Python SDKの両方で同じ403を再現するため、ローカル実装固有の問題ではない。
- Google Cloud公式のGemini API IAM一覧は、このサービスに利用者が追加できるIAM権限が存在しないと明記している。GET/cancel専用の追加ロールは設定できない。
- Google公式SDKリポジトリおよびGoogle AI Developers Forumにも、作成成功後のGET/cancelが失敗するInteractions API側の事例が報告されている。

したがって、ユーザー側でAuthorization keyを再発行したり、課金を有効化したり、OAuth同意画面を設定したりしても、この状態依存の403を解決する根拠はない。第1ゲートは機能上未達のままであり、通常GET pollingと実行中cancelを必須とするMVP実装は、Google側の修正確認または設計変更まで開始しない。

## background非依存経路の実装後確認（2026-08-15）

ユーザー指示により、Google側の状態依存403を回避するローカル検証方式へ設計を変更した。

- 既定 `MOCK_MODE=true` ではGemini通信を行わず、ローカル模擬進捗と決定的な正式9項目結果を返す。
- `MOCK_MODE=false` では `background` を送らず、`store=false` の同期 `POST /v1beta/interactions` だけを使用する。
- interaction IDのGET polling、Gemini cancel、DELETE、保存・表示・ログ出力は実装しない。
- 中止は画面上の待機とローカルHTTPを中断し、後着結果を破棄する。Geminiクラウド側の停止は保証しない。

無料枠の `gemini-3.6-flash` を用い、APIキー値・interaction ID・応答本文を表示・保存せず、実動画・実PDFなしの固定テキストだけで同期疎通を実施した。正式9項目の2区間を取得し、構造・型のA検証に合格した。`gemini-3.1-pro-preview` は実行していない。

モック画面と自動テストの詳細は `docs/IMPLEMENTATION_RESULT.md` に記録した。
