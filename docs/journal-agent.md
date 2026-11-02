# 非同期の日報作成エージェント

2026-11-03: 従来のメインAgent内の単発JSON生成と07:00定期生成を、独立した日報作成エージェントへ置き換えました。メインは日報に関して `ask_journal_agent` ツールだけを持ちます。Journal MCPを直接操作するコード・Service Binding・秘密値は日報専用Workerへ分離しています。

## 構成

```text
メインの会話
  -> ask_journal_agent(prompt, reportSessionId?)
  -> メインDOの永続outbox
  -> niao-journal-prompts Queue (job IDだけ)
  -> apps/journal-agent / JournalAgent SQLite DO
     -> 最新リリース
     -> 当日のチャット履歴の読み取りRPC
     -> Niao Journal MCP
  -> 永続result receipt
  -> niao-journal-results Queue (job IDと日報session IDだけ)
  -> 元の会話へmessage_added / 履歴保存
```

Queue送信に失敗しても、ジョブごとに永続登録した60秒ごとのmaintenanceがoutboxを再送します。完了後はその予定を解除します。Queueは重複・順序変更を前提にし、同じ日報セッション内の先行ジョブを優先します。処理結果と通知はjob IDで重複を防ぎます。会話を削除・初期化すると、epochが一致しない古いジョブの読み取り・通知は拒否します。進行中ツールも毎回元ジョブの有効性を確認します。

日報用セッションは元のチャットルームごとに作成し、最初の起動から12時間で期限切れになります。追加入力は同じコンテクストを引き継ぎ、期限は延長しません。`reportSessionId` を指定した期限切れ・他ルームのセッションへの入力は拒否します。省略した場合は有効なセッションを再利用し、なければ新しく作成します。期限到達時は会話・ツール結果・作成intentを消去し、期限切れの処理結果だけを残します。

## モデルとツール

モデルは `@cf/qwen/qwen3.8-27b`、thinking有効、`reasoning_effort:xhigh` に固定しています。メイン側のモデル設定やQwenのlow設定は変えません。各推論は最大16384 completion tokens、1ジョブ最大16推論ラウンド／24ツール実行、最大6分またはセッションの残り時間までです。セッション全体のコンテクストにも文字数上限を設け、超えた場合は新規セッションを案内します。

- `get_niao_latest_release`: GitHub公式API `https://api.github.com/repos/udzura/niao-agent/releases/latest` から直接取得します。取得失敗はエラーとして返します。外部テキストは不信な参考データです。
- `read_today_chat_sessions`: JSTの当日、現在残っているチャットを部屋別・時系列で整形します。アーカイブした部屋も含み、削除済みの部屋やthinkingは含めません。チャットの実体はD1ではなく、承認された既存DO SQLiteから取得します。1ページ最大100メッセージ、本文2000文字まで。長文はmessageSeqとoffsetで続きを取得できます。afterSeqで部屋をまたいでページングします。既知の秘密値や認証情報をマスクします。
- `journal_*`: MCP SDKでJournalのtoolを検出し、このエージェント内だけに登録します。作成・更新・一覧・取得を利用できます。LLMからの公開ツール呼び出しは拒否し、下書き用トークンにも公開権限はありません。承認済みジョブだけが、固定の記事ID・確認版を使う専用処理から公開用トークンでpublish_articleを実行します。

1プロンプトにつきcreate_draftは最大1件とし、最初の作成内容と固定idempotencyKeyを永続化します。曖昧な通信失敗や再起動で再推論されても、同じジョブの作成を重複させません。その下書きの修正にはupdate_draftを使います。完了したツール結果とモデルの会話をチェックポイントとして保存し、追加入力や再起動後に再利用します。思考過程は保存・メインへの返信には含めません。

## ツール入力例

```json
{"prompt":"今日の会話と最新リリースを確認して、Niao自身の日記を下書きにしてください"}
```

受付にはjobId、reportSessionId、expiresAtが返ります。本文や完了結果は後で元の会話に届きます。

```json
{"prompt":"技術的な気づきをもう少し詳しく書いてください","reportSessionId":"<受付時のUUID>"}
```

メインAgentの旧 `/journal/generate`、`/journal/articles`、`/journal/articles/:id/publish` は廃止しました。Journal自身のMCPと `/review` に加え、会話内の下書き提示・公開承認を利用できます。従来の07:00 cronは次回起動時に解除します。今回は新しい定期実行は追加していません。

## 下書き提示から公開まで

1. メインの会話で「今日の日報を書いて」と依頼します。すぐに受付を返し、日報エージェントが非同期で調査・下書き保存します。
2. 保存済みの最新本文をJournalから再取得し、タイトル・説明・本文・公開ソースと確認版を元の会話に提示します。下書きは未公開です。
3. 修正したい場合はその内容を返信します。修正後の本文を再提示するので、改めて確認します。
4. 直近に提示した内容で公開する場合は、同じ会話で **「公開して」** と返信します。「公開してください」「承認します」「承認して公開してください」も受け付けます。句点・末尾の感嘆符は任意です。「はい」だけ、引用中の承認文、否定文は承認として扱いません。
5. メイン側は実際のuserメッセージを確認し、提示済みの記事ID・更新日時に限った承認を永続化します。LLMの委譲プロンプトやツール引数から承認を生成することはできません。
6. 公開は再びQueue経由で行い、成功するとHTML/MarkdownのURLが会話へ届きます。確認後に本文が変わっていた場合は公開しません。最新の下書きを提示し直してから再承認してください。

承認は同じ元の会話・epoch・12時間の日報セッションに限定します。まだ本文が提示されていない、別の処理が進行中、期限切れの場合は承認を受け付けません。公開済み本文の編集・取り下げは従来どおりv1の対象外です。

公開用secretを追加した後は、`@niao/journal-agent`、`@niao/worker` の順に再デプロイしてください。Journal Worker自体の再デプロイやD1マイグレーションは不要です。

## Cloudflare設定

本変更はデプロイしていません。Journalの既存デプロイはそのまま利用します。

1. Queueを4つ作成します。

```sh
npx wrangler queues create niao-journal-prompts
npx wrangler queues create niao-journal-prompts-dlq
npx wrangler queues create niao-journal-results
npx wrangler queues create niao-journal-results-dlq
```

2. `apps/journal-agent` Workerに、Journalと同じ下書き用 `JOURNAL_AGENT_TOKEN` をsecretとして設定します。会話からの承認後公開を使う場合は、同じ専用WorkerにJournalと同じ公開用 `JOURNAL_PUBLISH_TOKEN` も設定します。メインWorkerには公開用トークンを設定しません。以前メインWorkerに設定したJournal用secretは、移行時に削除してください。ローカルの `.dev.vars` も専用Workerへ移します。secretの値をGitやQueueに含めないでください。
3. 接続は `JOURNAL` Service Bindingが既定です。別アカウント等で外部MCP URLを使う場合は、専用Workerに `JOURNAL_MCP_URL=https://<Journalのホスト>/mcp` を設定できます。リダイレクトは拒否します。
4. 既存のNiaoAgent DO namespaceを参照して、専用Workerをデプロイします。次にメインWorkerを更新し、逆向きのJournalAgent DO bindingとQueueを有効にします。両namespaceが存在してから運用してください。
5. メインWorkerには `JOURNAL_PROMPTS` producerと結果Queue consumer、日報Workerには指示Queue consumerと `JOURNAL_RESULTS` producerが必要です。設定は各wrangler.jsoncに追加済みです。DLQを監視し、滞留があればbindings・秘密値・履歴のジョブ状態を確認します。

専用Workerには公開HTTPルートを作りません。`workers_dev:false`、`preview_urls:false` とし、Agent DOの任意インスタンスをインターネットから生成できない構成です。実際の運用ではメインWorkerからJournalへの旧権限を外すことも忘れないでください。

## GitHub APIの認証と取得失敗

公開リリースは未認証でも取得できますが、GitHub REST APIの未認証リクエストは送信元IPごとに通常60回/時の制限があります。日報専用Workerには任意の `GITHUB_TOKEN` secretを設定できます。設定した場合だけ、固定のGitHub API URLへAuthorizationヘッダーで送ります。リダイレクト先へは送信しません。メインWorkerへの設定は不要です。

```sh
npx wrangler secret put GITHUB_TOKEN --config apps/journal-agent/wrangler.jsonc
npm run deploy -w @niao/journal-agent
```

GitHubで発行したトークンを入力します。Journal用のランダム文字列とは別物です。用途は公開リリースの読み取りだけなので、書き込み権限は付けないでください。必要に応じて対象リポジトリを限定したfine-grained PATのContents: readを使えます。

取得失敗は、`release_rate_limited`、`release_unauthorized`、`release_forbidden`、`release_unavailable` を区別します。HTTP statusと、存在する場合は残り回数・制限解除のUTC epoch秒・Retry-After秒数を安全なログとツール結果へ返します。秘密値やGitHubのエラー本文は返しません。失敗したリリース内容をモデルが創作しないよう、ツール説明にも明記しています。

参考: [GitHub REST APIレート制限](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)、[最新リリース取得](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)。

## 検証

`npm test`、`npm run typecheck`、`npm run build:worker`、`npm run build:journal-agent` を使います。テストではLLMを置き換え、実際のDO SQLite、MCP SDK、JournalのローカルD1で下書き作成・継続・再起動・Queue往復・期限切れを確認します。本番LLMによる生成や本番Queueへの投入、記事の公開は自動テストでは実行しません。

2026-11-03の検証結果: 日報Agent 5件、メインWorker 306件、Journal 21件、Past Logs 39件、importer 13件の計384件が成功しました。全workspaceの型チェック、メイン／日報WorkerのWrangler dry-runも成功しています。実環境のQueue配線とxhigh推論はデプロイ後の確認事項です。

公式APIの確認先: [Qwen 3.8 27B](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/)、[Queues limits](https://developers.cloudflare.com/queues/platform/limits/)。
