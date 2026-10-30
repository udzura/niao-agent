# Cosenseの自動同期

Cosenseを原本とし、Past Logsは検索用の写しです。公開プロジェクトのみ対応します。既存のREST/MCPと手動インポーターはそのまま利用できます。

## 同期の流れ

`scheduled` が毎時RSSをXMLパーサーで解析し、URLと日時をD1へ保存します。GUIDをページIDには使いません。未完了候補を古い順に最大8件Queueへ送ります。RSSから消えた取得済み候補もD1に残るため後で処理できます。グローバルな最終日時による足切りはしません。

Queueは1件ずつ、同時実行1で処理します。APIから安定したページIDを取得し、ページ単位のD1リースを取ってから最新本文を再取得します。既存インポーターと同じ `source_id = project/pageId` を使用し、改名でも文書IDは変わりません。Scrapbox記法・改行・字下げ、元の作成・更新日時を保持します。本文はログへ出しません。

既存のDocumentServiceがD1とFTS5を更新し、SemanticIndexが決定的なチャンクID、古いベクトルの削除、進捗・リースの保存を担当します。本文とタイトルが変わらなければ再embeddingしません。Vectorize設定時は登録と旧ベクトルの削除要求がすべて受理されるまでackせず、pendingの続きから再試行します。Vectorizeの検索への反映はeventualです。未設定時はD1/FTS5成功をもってackし、意味索引は既存のpending/reindexで後から補えます。

成功したQueue送信の前には配信済みと記録しません。不確実な送信は重複する可能性がありますが、文書IDとリース・索引状態で再処理します。未完了候補は2時間後にCronが再送可能です。短い送信予約中のクラッシュは2分で回復します。5回のQueue再試行後はDLQへ移動し、D1の失敗状態も残します。Cronによる再送はDLQの手動処理と重複する可能性があります。

## 設定とデプロイ（手動）

リポジトリルートで依存を `npm ci` した後、次を **apps/past-logs** で実行します。

```sh
npx wrangler queues create niao-cosense-sync
npx wrangler queues create niao-cosense-sync-dlq
npx wrangler d1 migrations apply DB --remote --env=""
npm run deploy
```

追加migrationは `0003_cosense_sync.sql`。discovery（候補と配信状態）、pages（ページID・hash・最終同期・失敗・リース）、poll（最終成功）、backfill（再開位置）の4表です。既存記事の移し替えや全件再embeddingは不要です。Queue、migrationを準備してからデプロイしてください。Agent/Ruby Runner/アプリの変更は不要です。

Wranglerの本番設定:

- `COSENSE_PROJECT_NAME`: `udzura-lofi-memo`
- `COSENSE_SYNC_ENABLED`: `"true"`。`"false"` でRSSポーリングを停止します。既にQueueへ送った仕事や明示的なbackfillは停止しません。
- `COSENSE_FEED_URL`: 任意。初期実装はSSRF防止のため同じCosenseプロジェクトの `/api/feed/{project}` のHTTPS URLに限定します。
- `COSENSE_SYNC_QUEUE`: producer binding。consumerとDLQは同じwrangler.jsoncで設定します。

追加の秘密鍵は不要です。管理APIは既存の `PAST_LOGS_ADMIN_TOKEN`、MCPは別のread tokenです。

## 初回同期と再開

デプロイでは全件同期しません。RSSは最近の更新のみなので、初回は下記APIを `has_more:false` まで繰り返します。1回5ページのメタデータを取得し、必要な仕事だけQueueへ送ります。小さいバッチはFreeのサブリクエスト上限に余裕を残すためです。

```sh
export PAST_LOGS_URL='https://niao-past-logs.udzura.workers.dev'
# PAST_LOGS_ADMIN_TOKENは既存の管理トークンを環境変数へ設定
curl --fail-with-body "$PAST_LOGS_URL/api/cosense-sync/backfill" \
  -H "Authorization: Bearer $PAST_LOGS_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"dryRun":true}'

# 同じコマンドを繰り返す。D1に再開位置が保存される。
curl --fail-with-body "$PAST_LOGS_URL/api/cosense-sync/backfill" \
  -H "Authorization: Bearer $PAST_LOGS_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{}'
```

`has_more:false` は全メタデータの走査・enqueueの完了で、索引の完了ではありません。`{"reset":true}` を最初の1回に指定すると先頭から走査できます。dryRunはQueue・チェックポイントを変更せず、現在位置のページ数を確認します。変更されていない記事はスキップします。送信が一部失敗した要求は位置を進めず、再実行で残りを送れます。途中で更新されたページ一覧はスナップショットではないため、走査中に記事の追加・削除が多かった場合はresetで再走査してください。

## 状態確認と復旧

```sh
curl --fail-with-body "$PAST_LOGS_URL/api/cosense-sync" \
  -H "Authorization: Bearer $PAST_LOGS_ADMIN_TOKEN"
curl --fail-with-body "$PAST_LOGS_URL/api/semantic-index" \
  -H "Authorization: Bearer $PAST_LOGS_ADMIN_TOKEN"
```

最終poll成功は候補の保存・dispatch成功を表し、全記事の索引完了ではありません。ページごとの失敗はD1の `cosense_pages.last_error`、索引の詳細は `semantic_jobs.last_error` に残ります。DLQをCloudflare Dashboardで確認し、原因を解消して再送するか、backfillをresetで再走査します。大きい記事で索引が複数回に分かれる場合も既存のreindex APIが使えます。DBから文書を手動削除した場合、同じ日時の既存discoveryが完了済みならRSSだけでは復元しません。backfillの再走査を使用してください。

## ローカル確認

```sh
npm run db:migrate -w apps/past-logs
npm run dev -w apps/past-logs -- --test-scheduled
# 別ターミナル。通常のdevelopmentはsync無効。
curl 'http://127.0.0.1:8788/__scheduled?cron=0+*+*+*+*'
```

実RSSの確認は `.dev.vars.development` 等で `COSENSE_SYNC_ENABLED=true` を明示します。ローカルQueueもWranglerが配信します。開発Queue名は `niao-cosense-sync-dev` と `niao-cosense-sync-dev-dlq`、本番とは別です。remoteで開発する場合だけこれらを作成してください。AI/Vectorizeは既存のremote bindingで利用量が発生します。`dev:offline` は従来通りキーワード検索専用で、自動同期Queueを設定しません。

自動テストは外部HTTPのfixture、ローカルD1、明示的なAI/Vectorizeのtest doubleを使用し、本番資格情報・Cosenseへの書き込み・本番データを使いません。

## 費用と制限

[Queues Free](https://developers.cloudflare.com/queues/platform/pricing/) は1日10,000 operations、保持24時間です。小さいメッセージは通常送信・受信・削除の3 operations、再試行でも追加消費します。RSSは毎時、1poll最大8送信。初回同期とembeddingの利用量は別途見積もってください。キューはFreeで利用できますが、Workers AI/Vectorizeの既存の割当・課金条件も引き続き適用されます。

FreeのCPU時間は本番での負荷計測を完了していません。ローカルworkerdテスト・dry-run成功は実運用CPU上限の保証ではありません。長い記事のFTS生成、XML解析、既存のチャンク分割が上限に当たる場合はDLQ/状態を確認し、記事サイズ・バッチ・既存のindex制限を調整します。Dynamic WorkersやPaid専用機能へ自動フォールバックしません。

RSS上限100候補・XML1MiB、API応答512KiB、HTTP待ち15秒。既存の文書上限（本文128KiBなど）は保持し、本文を黙って切り詰めません。RSSに載る前に消えた更新、長時間の停止中にRSSから消えた未発見ページはbackfillが必要です。取得前に改名されて旧URLが404になったジョブは再試行・DLQへ進み、新URLのRSSまたはbackfillで取り直します。旧ジョブから別IDのページへの誤った上書きはしません。

非公開プロジェクトにはRSSがなく対象外です。削除同期も未実装です。将来は低頻度の全ページID照合で削除候補を記録し、再確認・猶予期間後に既存の削除サービスへ渡す方針です。

参照: [Cosense API](https://scrapbox.io/help-jp/API)、[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、[Queues ack/retry](https://developers.cloudflare.com/queues/configuration/batching-retries/)。
