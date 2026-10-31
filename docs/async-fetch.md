# 非同期Web Fetch

`web_fetch_async({"url":"https://example.com/article"})`はURLを1件受け付け、会話を待たせずに取得し、後から同じ会話へ短い要約を追加します。

依頼例: 「このURLをバックグラウンドで読んでおいて。終わったら要約を教えて」。通常の`web_fetch`はそのターンで本文を使って回答する用途として残しています。

同期版がタイムアウト・一時利用不可・DNS失敗・429で失敗した場合も、同じURLを`web_fetch_async`へ1回投入するようモデルへ指示しています。ユーザーがバックグラウンド処理を禁止している場合は行いません。サイズ/DOM上限・危険URL・非対応形式・文字コード・抽出エラー等は制限が共通なので再投入せず理由を説明します。受付成功前に開始済みと伝えず、ツール上限等で投入できなかった場合も正直に報告します。これはプロンプトによる誘導で、モデル選択・追従性やターンの残りツール実行枠によっては切り替わらないことがあります。必ず非同期にしたい依頼では明示してください。

## 構成

```text
web_fetch_async
  → NiaoAgent SQLite（ジョブ・再送待ち状態）
  → niao-fetch-jobs Queue
  → niao-agent の queue() handler
  → TOOLS_MISC.webFetch() / 既存の取得・抽出・制限
  → NiaoAgent内部RPC（結果を永続化してからQueueをack）
  → Agentが空いたときに要約生成
  → assistant履歴を保存 → WebSocket message_added
```

新しいWorker、D1、R2、Workflowsは追加しません。Queue Consumerは既存の`niao-agent` Workerに置きます。tools-miscは取得・抽出だけを担当し、Agentの秘密情報やストレージ権限を受け取りません。Queue payloadも`v/kind/jobId/epoch`だけです。

Agent SDKのSQLite・`scheduleEvery()`・`queue()`・アラーム管理を利用します。Cloudflare Queuesへの送信とSQLiteの更新は単一トランザクションにできないので、先にジョブ固有の復旧スケジュールを永続化し、それからジョブを保存します。送信失敗は`pending`として残り、60秒間隔で再送します。ジョブ保存前に停止した場合の空のスケジュールは自分を削除します。物理アラームを独自実装しません。

`niao_fetch_jobs`テーブル・索引はAgent起動時に作成します。追加のWrangler Durable Object migrationやD1 migrationは不要です。既存チャット・設定・利用統計を消しません。

## 通知と復旧

- 同じepoch・ユーザーrequestId・正規化URLは1ジョブに統合。別のユーザーターンからの再依頼は新規ジョブです。
- 実行leaseは120秒。重複配信中の同時取得を避け、期限切れの実行は新しいtokenで再取得可能にします。古いtokenの完了結果は無視します。
- 一時的なネットワーク障害・タイムアウト・DNS失敗・429はQueueメッセージの5回目の試行で結果を確定。配送基盤の失敗はQueuesのリトライとDLQに任せます。
- 未完了のQueue配送は5分経過で再送可能。Queue投入は最大5回、取得ジョブの期限は1時間です。再配信・再投入で外部取得が複数回走る可能性はあります。
- 結果を保存したらQueueをackします。通知モデルの失敗でWebページを取り直しません。
- 最初の受付ターン・通常の返信・別の通知が実行中なら結果だけを保存します。ターン終了時、結果保存時、復旧スケジュールで通知待ちを確認します。
- 通知生成も通常返信と同じ単一実行ゲートを使います。生成中は`partial`で待機表示し、通知に対応する`message_added` / `notification_deferred`で解除します。通知は最終本文だけを公開します。
- 通知モデルは生成開始時のモデル設定を使用し、ThinkingはOFF、judge・Ruby・MCP・他のツールは呼びません。取得した文章から新しいジョブを連鎖させません。
- 要約は90秒でタイムアウト。最大3回のモデル呼び出し後も失敗する場合は、取得済みであることと参照URLだけを通知します。取得自体の失敗はエラーコードとURLを通知します。
- 通知モデルの試行・観測できたNeuronsも既存の利用統計に記録します。取得HTTP自体にWorkers AI Neuronsは発生しません。
- 通知本文・履歴の完了状態・ジョブの通知済み状態を同じSQLiteトランザクションで保存し、その後配信します。メッセージIDは`notification:<jobId>`で一定です。通知済みの取得結果本文は削除します。
- アプリ切断中も処理・通知生成はサーバー側で続行します。アプリ再起動時は既存HTTP履歴同期で回収します。OSプッシュ通知はありません。
- 履歴クリアはジョブ行も削除しepochを進めます。遅れて届いた結果は会話を復活させません。すでに走っている外部fetchの即時キャンセルは保証しません。

## 制限とセキュリティ

未通知ジョブは同時3件まで。Queueのbatch size/concurrencyも1です。1件ごとの復旧スケジュールは完了後に削除され、アイドル中に定期ポーリングし続けません。通知が複数溜まった場合は順に処理し、約60秒以上の待機が生じることがあります。完了順・通知順は厳密な依頼順を保証しません。

取得は同期版と同じ[Web Fetchのサイズ・時間・SSRF制限](web-fetch.md)です。32KiBのダウンロード上限、DOM制限等を緩和しません。URLを受付時にも検証し、DNS・リダイレクトの検証は実際の取得時に再実施します。本文・タイトル・元の依頼は通知モデルへ明示的な参照JSONとして渡し、引用内容を命令として扱わせません。内部完了RPCをHTTPやWebSocketのcallableとして公開しません。ログはjobId・状態・安全なコード等に限定し、URL・本文・トークンは出しません。

QueuesはFreeで利用できますが、非同期化はCPU・メモリ制限の解消ではありません。HTML抽出の制限・既知のDNS rebindingの限界も残ります。FreeのQueues枠はアカウントで既存Cosense同期と共有し、保持期間も有限です。Agent側の未完了状態・期限と復旧処理はQueueだけに依存しません。本番CPU・配信遅延は未検証です。

## ローカル開発とテスト

```sh
npm run dev
```

既存のmulti-worker Wrangler開発にローカルQueuesも接続されます。本番Queueを作成する必要はありません。従来通りAgentの`.dev.vars`、実際のWorkers AI呼び出しに必要なCloudflare開発認証を設定し、Mac/iOSアプリからローカルAgentへ接続します。

```sh
npm run test -w apps/worker
npm run typecheck
npm run build:worker
npm run build:macos
npm run test:ios
```

`test/fetch-jobs.test.ts`は実際のworkerd、SQLite、ローカルQueue producer/consumer、Agent SDKの復旧schedule、コンパイル済みtools-miscのService Bindingを使います。外部サイトとモデル回答のみfixtureにして本番認証を不要にしています。重複、通知保留、取得・通知リトライ、再起動、期限、履歴削除、利用量、通知から他のツールを呼べないことを検証します。

## デプロイ

以下は手動手順です。実装時にはデプロイしません。新しいsecretはありません。

初回のみ、リポジトリルートからQueueを作成:

```sh
npx wrangler queues create niao-fetch-jobs
npx wrangler queues create niao-fetch-jobs-dlq
```

tools-miscが未反映なら先にデプロイし、その後Agentを反映:

```sh
npm run deploy -w apps/tools-misc
npm run deploy -w apps/worker
```

`apps/worker/wrangler.jsonc`がproducer、consumer、DLQを設定しています。環境を分ける場合はQueue名・DLQ名・bindingsも分離してください。

Mac/iOSクライアントも更新してください。新しい`message_added`を受け取れる版を先に導入するのが安全です。旧版は即時通知を表示できず、20秒間隔の履歴照合や再接続後のHTTP同期で通知本文を取得します。

Mac:

```sh
npm run build:macos
open apps/macos/build/Build/Products/Debug/Niao.app
```

iPhone実機は`apps/ios/Niao.xcodeproj`をXcodeで開き、従来のTeam・実機選択で再ビルド/実行します。

ログ確認:

```sh
npx wrangler tail -c apps/worker/wrangler.jsonc --format pretty
```

`fetch_job.created` → `enqueued` → `started` → `result_saved` → `summary_started` → `notified`が正常系です。取得失敗時は`retry`、配送失敗は`delivery_failed`、投入失敗は`enqueue_failed`、要約失敗は`notification_failed`を確認します。DLQ滞留はCloudflare DashboardのQueuesで確認できます。

参考: [Queues + Durable Objects](https://developers.cloudflare.com/queues/examples/use-queues-with-durable-objects/)、[Queues配信保証](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)、[Agentsスケジューラ](https://developers.cloudflare.com/agents/agent-class/schedule-tasks/)、[Queues料金](https://developers.cloudflare.com/queues/platform/pricing/)。
