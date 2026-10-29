# CosenseからPast Logsへ取り込む

`https://scrapbox.io/udzura-lofi-memo/`を標準の取得元とするスクリプトです。公開プロジェクトのページ一覧を取得し、各ページをPast LogsのREST APIへ逐次upsertします。外部サイトへのリンクや添付ファイルは巡回・ダウンロードしません。Cosenseへの書き込みも行いません。

[Cosense公式ヘルプのAPI](https://scrapbox.io/help-jp/API)にあるページ一覧（skip/limit）とページ詳細を使用します。内部APIなので仕様変更時には取得が失敗する可能性があります。取得形式を検証し、異常を空の記事などで補いません。非公開プロジェクトのログイン/Cookie認証は今回の対象外です。

## 一覧を確認

リポジトリルートで`npm ci`を実行後:

```sh
npm run import:cosense -w apps/past-logs -- --list
```

本文を取得せず、ID・題名・更新日時・URLをJSONで出力します。トークンは不要です。ファイルへ保存する場合は、npmの出力を抑制します。

```sh
npm --silent run import:cosense -w apps/past-logs -- --list > /tmp/cosense-pages.json
```

## 登録前に検証

```sh
# 先頭3ページのみ取得・整形・サイズ検証
npm run import:cosense -w apps/past-logs -- --dry-run --limit 3

# 全ページを検証（Past Logsへの登録、チェックポイントの書き込みはしない）
npm run import:cosense -w apps/past-logs -- --dry-run
```

取得した本文はメモリ内で検証し、記事内容はログやリポジトリへ保存しません。通常の進捗ログはページID・状態・サイズのみです。`--list`は一覧を確認するため題名も出力します。

## インポート

Past LogsのD1マイグレーションとWorkerの起動・デプロイを先に済ませてください（[基本設定](past-logs.md)、[意味検索の設定](past-logs-semantic.md)）。以下はzshでの実行例です。

```sh
# NiaoAgentではなく、Past Logs WorkerのルートURL
export PAST_LOGS_URL='https://niao-past-logs.<your-subdomain>.workers.dev'
read -rs 'PAST_LOGS_ADMIN_TOKEN?Past Logs admin token: '; echo
export PAST_LOGS_ADMIN_TOKEN

# まず先頭3ページを登録
npm run import:cosense -w apps/past-logs -- --limit 3

# 確認できたら全ページ。取り込み済みの3ページはスキップ
npm run import:cosense -w apps/past-logs
```

ローカルなら`PAST_LOGS_URL=http://127.0.0.1:8788`にします。URLを省略した場合もこのローカルURLです。admin tokenは環境変数から読み込み、Cosenseへ送信しません。HTTPS必須（loopbackのみHTTP可）で、認証情報を含むURLやリダイレクトは拒否します。本文を取得する前にPast Logsの管理APIで認証を確認します。

`--limit N`は一覧をID順に並べた先頭Nページを対象にする試行用の指定です。続きの全件取り込みではlimitを外してください。

## 再実行・途中再開

成功したページのID・題名・更新日時・登録先の文書IDを、`apps/past-logs/.import-state/`へ1件ずつアトミックに記録します。このディレクトリはGit対象外で、状態ファイルはmode 0600です。本文やadmin tokenは記録しません。

同じコマンドを再実行すると、同じ登録先に取り込み済みで、題名・更新日時が変わっていないページをスキップします。登録先URLごとにチェックポイントを分けるため、ローカルへの取り込み済み状態を本番へ流用しません。

```sh
# 中断・一時的な失敗後の再開
npm run import:cosense -w apps/past-logs

# 状態ファイルを明示する場合
npm run import:cosense -w apps/past-logs -- --state /absolute/path/cosense-state.json

# 登録先DBを消去した場合など、チェックポイントを無視して全ページupsert
npm run import:cosense -w apps/past-logs -- --force
```

ページIDを`source_id`に使うため、再送・改名でも同じD1文書を更新します。`--force`も記事の重複を作りません。登録済みの本文・タイトルが同じなら、バックエンド側もEmbeddingを再実行しません。更新判定はCosenseの題名・更新タイムスタンプによります。Cosense側から削除されたページをPast Logsから自動削除する同期処理はありません。

## 保存形式

| Past Logsのフィールド | Cosenseからの値 |
| --- | --- |
| source | `cosense` |
| source_id | `udzura-lofi-memo/<不変のページID>` |
| url | 元ページのURL（題名をURLエンコード） |
| title | 取得時点の題名 |
| body | `lines[].text`を改行で連結した元テキスト |
| created_at / updated_at | 元のUNIX秒をUTC ISO 8601へ変換。不明な公開日時はnull |
| metadata | project、page_id、format=`scrapbox`、importer_version |

コードのインデント、空行、内部リンク、ハッシュタグ等を保持し、HTML実行や不完全なMarkdown変換はしません。元データの題名行も本文へ含めます。各行のユーザー情報など、取り込みに不要なメタデータは保存しません。indexed_atは既存APIが記録する取り込み日時です。

一覧と本文のページIDが違う場合は、取得中の改名・削除などとしてエラーにします。一覧の件数とユニークなID数が一致しない場合も一覧取得を再試行し、部分的な一覧を全件成功と扱いません。取得中の継続的な編集に対する完全なスナップショット保証はないため、その場合は再実行してください。

## 実行量・エラー

全リクエストを逐次処理し、既定で開始間隔を最低300ms空けます。調整する場合は`--delay-ms 1000`のように指定できます。429と一時的なエラーは最大3回試行し、指数バックオフとRetry-Afterに従います。60秒を超える待機要求、認証失敗、レート制限の継続、バックエンド障害などではチェックポイントを残して停止します。

Cosenseのページが消えていた、本文がAPI上限128 KiBを超えた等のページ単位のエラーは記録して次へ進みます。本文を黙って切り詰めることはありません。終了時のsummary.failedが1以上なら終了コード1です。停止時の生のレスポンス・例外本文・認証値は出力しません。

D1への保存が成功し、意味索引がpendingの場合も取込済みとして記録します。これはキーワード検索を利用できる状態です。CloudflareのAIクォータ不足や未設定等を解消後、既存の管理コマンドで意味索引を回復できます。

```sh
npm run reindex -w apps/past-logs
```

インポート時のEmbeddingとVectorizeには利用量が発生します。全件取り込みはこのコマンドを実行したときだけ行い、Cronや自動巡回は追加しません。

## 別プロジェクト・検証

```sh
npm run import:cosense -w apps/past-logs -- --project https://scrapbox.io/another-project/ --dry-run --limit 3
npm run test:importers -w apps/past-logs
```

Node標準テストでページング、形式・上限、再開、更新・改名、トークンの送信先、pending状態、レート制限を検証します。実サイトへのdry-runとローカルD1への少数ページ取り込みで実APIの形式も確認します。本番への全件登録は実行しません。

2026-10-29の実行確認では、公開402ページの一覧取得と全件dry-runが成功しました。実記事2件を一時ローカルD1へ登録し、再実行時のスキップと元URL・日時・本文の保持も確認済みです。Nodeテスト13件と既存バックエンド120件が成功しています。本番への登録・Embedding実行はしていません。
