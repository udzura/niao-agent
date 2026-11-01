# 非同期Web Fetch

`web_fetch_async({"url":"https://example.com/article"})`はURLを1件受け付け、会話を待たせずに取得し、後から同じ会話へ短い要約を追加します。

依頼例: 「このURLをバックグラウンドで読んでおいて。終わったら要約を教えて」。通常の`web_fetch`はそのターンで本文を使って回答する用途として残しています。

同期版がタイムアウト・一時利用不可・DNS失敗・429・HTMLサイズ上限・DOM複雑度・記事抽出で失敗した場合も、同じURLを`web_fetch_async`へ1回投入するようモデルへ指示しています。ユーザーがバックグラウンド処理を禁止している場合は行いません。非同期版はBrowser RunでHTMLをMarkdown化するため、同期版のDOM制限を引き継ぎません。危険URL・非対応形式・文字コードエラー・空本文・結果サイズ超過は再投入せず理由を説明します。受付成功前に開始済みと伝えず、ツール上限等で投入できなかった場合も正直に報告します。これはプロンプトによる誘導で、モデル選択・追従性やターンの残りツール実行枠によっては切り替わらないことがあります。必ず非同期にしたい依頼では明示してください。

## 構成

```text
web_fetch_async
  → NiaoAgent SQLite（ジョブ・再送待ち状態）
  → niao-fetch-jobs Queue
  → niao-agent の queue() handler
  → TOOLS_MISC.webFetchAsync()
  → 検証済みHTTP取得 → HTMLRewriterで能動要素を除去
  → BROWSER.quickAction("markdown", {html, ...}) / Browser Run
  → 本文と結果サイズを制限
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

非同期版は`webFetchAsync()`を使い、同期`webFetch()`のReadability / LinkeDOM / Turndownを実行しません。公開URL/DNS・手動リダイレクトの検証とストリーム上限は[既存の取得処理](web-fetch.md)を再利用します。

| tools-miscの設定 | 既定値 | 範囲 |
|---|---:|---:|
| `WEB_FETCH_ASYNC_TIMEOUT_MS` | 45,000 ms（取得と変換の合計） | 100–60,000 |
| `WEB_FETCH_ASYNC_MAX_DOWNLOAD_BYTES` | 524,288 bytes（512 KiB） | 1,024–1,048,576 |
| `WEB_FETCH_ASYNC_MAX_CONTENT_CHARS` | 12,000 UTF-16単位 | 100–32,000 |
| `WEB_FETCH_ASYNC_MAX_RESULT_BYTES` | 32,768 bytes | 8,192–65,536 |

この設定は同期版の`WEB_FETCH_*`から独立しています。HTMLのDOM要素数上限は非同期版に適用しません。Browser Runの応答JSONは256 KiBまで読み込み、出力本文はサロゲートペアを壊さず切り詰めます。結果JSON上限はAgentの永続化形式の64 KiB以下に固定しています。HTMLソースまたは変換応答そのものが上限を超えた場合はエラーです。

HTMLは安全性を検査したHTTP取得の結果を`html`パラメーターで渡します。`url`を直接Browser Runに渡さないため、そこで未検証のredirectや追加取得を行わせません。軽量なネイティブHTMLRewriterでscript / frame / embed / 元のbase / http-equiv meta / noscriptを除去し、リンク・画像URLを取得後の最終URL基準で絶対化します。その前にCSP（default-src / script-src等をnone）と信頼するbaseを挿入し、Browser Runへ`setJavaScriptEnabled:false`、`rejectRequestPattern:[".*"]`、`cacheTTL:0`を渡します。

**HTMLモードではオプション適用前にHTML内のscriptが実行される挙動を実APIで観測したため、JavaScript無効化オプションだけには依存しません。** Worker側の能動要素除去と先頭CSPが必要です。HTMLRewriterのストリーム処理は行いますが、記事のDOM構築・本文抽出・Markdown変換はBrowser Run側に移ります。

JavaScriptでのみ生成される本文は対象外です。通常のHTML記事、plain text、Markdownに対応します。plain text / Markdownは変換不要なのでBrowser Runを呼びません。元URLと最終URLはWorkerが検証したものを返し、Browser Runの出力で上書きしません。タイトルは返された場合だけ使用します。byline / excerptや同期版と全く同じ記事抽出結果は保証しません。Browser Runによってナビゲーション等が残る場合があります。本文・タイトル・元の依頼は通知モデルへ明示的な参照JSONとして渡し、引用内容を命令として扱わせません。内部完了RPCをHTTPやWebSocketのcallableとして公開しません。ログはjobId・状態・安全なコード等に限定し、URL・本文・トークンは出しません。

QueuesとBrowser RunはFreeで利用できますが、WorkersのCPU・メモリ制限自体は残ります。重いDOM処理を外へ移しても、取得・HTMLRewriter・JSON処理・出力制限にCPUは必要です。DNSの事前検査と実接続の名前解決の間に生じるrebindingの限界も残ります。

Browser Run Freeの枠は2026-11-01確認時点でブラウザー時間10分/日、Quick Actionsは10秒に1件です。Queue concurrency=1でも短時間に続けて変換すれば429になり得るため、既存の指数バックオフで再試行します。消費したブラウザー時間は`misc.web_fetch_async.browserMs`（`X-Browser-Ms-Used`がある場合）に記録し、Workers AIのNeuronsには加算しません。実APIにはナビゲーションとアクション各20秒の期限も渡しますが、`quickAction()`にはAbortSignalがないため、Worker側期限を超えた際のリモート即時停止は保証しません。FreeのQueues枠はアカウントで既存Cosense同期と共有し、保持期間も有限です。Agent側の未完了状態・期限と復旧処理はQueueだけに依存しません。本番CPU・配信遅延は未検証です。

## ローカル開発とテスト

```sh
npm run dev
```

既存のmulti-worker Wrangler開発にローカルQueuesも接続されます。tools-miscの`browser: {binding:"BROWSER",remote:true}`は実際のCloudflare Browser Runへ接続するため、Wranglerログインと利用可能なBrowser Runが必要です。Quick Actionsは完全ローカルモードでは利用できません。`web_fetch_browser_not_configured`ならbindingを確認してください。Browser Runが利用できなくても同期版へ自動フォールバックしません。本番Queueを作成する必要はありません。従来通りAgentの`.dev.vars`、実際のWorkers AI呼び出しに必要なCloudflare開発認証を設定し、Mac/iOSアプリからローカルAgentへ接続します。

```sh
npm run test -w apps/worker
npm run typecheck
npm run build:worker
npm run build:macos
npm run test:ios
```

`test/fetch-jobs.test.ts`は実際のworkerd、SQLite、ローカルQueue producer/consumer、Agent SDKの復旧schedule、コンパイル済みtools-miscのService Bindingを使います。外部サイト、モデル回答、リモートBrowser Runを明示的なfixtureにして本番認証を不要にしています。重複、通知保留、取得・通知リトライ、再起動、期限、履歴削除、利用量、通知から他のツールを呼べないことを検証します。

## デプロイ

以下は手動手順です。新しいsecretやAPIトークンは不要です。`apps/tools-misc/wrangler.jsonc`の`BROWSER` bindingをデプロイで反映します。Worker名・既存Queue・Agentのジョブ形式は変わりません。

初回のみ、リポジトリルートからQueueを作成:

```sh
npx wrangler queues create niao-fetch-jobs
npx wrangler queues create niao-fetch-jobs-dlq
```

tools-miscを先にデプロイし、新しいRPCが利用できてからAgentを反映:

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


## 実Browser Runのスモークテスト

```sh
node apps/tools-misc/scripts/smoke-browser.mjs --real
```

Wranglerの既存認証を使い、架空の32 KiB超の日本語記事をローカルworkerdで処理し、リモートBrowser bindingでMarkdown化します。HTTP取得元だけがfixtureで、Browser Runは実呼び出しです。日本語、相対リンクの絶対化、script / 自動遷移の抑止を確認します。ブラウザー利用枠を消費するため通常のテストには含めません。Agentの会話は変更せず、本番Workerもデプロイしません。

[Browser Run /markdown](https://developers.cloudflare.com/browser-run/quick-actions/markdown-endpoint/)、[Browser bindingとローカル開発](https://developers.cloudflare.com/browser-run/reference/wrangler/)、[利用上限](https://developers.cloudflare.com/browser-run/limits/)。
