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

日報用セッションは元のチャットルームごとに作成し、最初の起動から12時間で期限切れになります。追加入力は同じコンテクストを引き継ぎ、期限は延長しません。`reportSessionId` を指定した期限切れ・他ルームのセッションへの入力は拒否します。省略した場合は有効なセッションを再利用し、なければ新しく作成します。期限到達時は会話・ツール結果・作成intentを消去し、期限切れの処理結果と、本文を含まない使用量記録を残します。

## モデルとツール

モデルは `@cf/google/gemma-4-26b-a4b-it`、thinking OFFに固定しています。メイン側のモデル・thinking設定は変えません。各推論は最大4096 completion tokens、1ジョブ最大6推論ラウンド／24ツール実行、最大6分またはセッションの残り時間までです。Queue再実行やisolate再起動でも、記録済み推論を含めて6回までとします。4096は1推論ごとの出力上限で、ジョブ全体の入力・出力トークン予算ではありません。セッション全体のコンテクストにも文字数上限を設け、超えた場合は新規セッションを案内します。

- `get_niao_latest_release`: GitHub公式API `https://api.github.com/repos/udzura/niao-agent/releases/latest` から直接取得します。取得失敗はエラーとして返します。外部テキストは不信な参考データです。
- `read_today_chat_sessions`: JSTの当日、現在残っているチャットを部屋別・時系列で整形します。アーカイブした部屋も含み、削除済みの部屋やthinkingは含めません。チャットの実体はD1ではなく、承認された既存DO SQLiteから取得します。1ページ最大100メッセージ、本文2000文字まで。長文はmessageSeqとoffsetで続きを取得できます。afterSeqで部屋をまたいでページングします。既知の秘密値や認証情報をマスクします。
- `journal_*`: MCP SDKでJournalのtoolを検出し、このエージェント内だけに登録します。作成・更新・一覧・取得を利用できます。明示的な公開指示があるジョブでは公開ツールも実行でき、専用処理が公開用トークンでpublish_articleを呼びます。下書き用トークン自体には公開権限を付けません。

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
4. 公開する場合は、同じ会話で **「この内容で公開して下さい」** と返信します。「公開してください」「公開して」を含む文章も受け付けます。従来の「承認します」も使えます。人間の発言だけでなく、メインAIが `ask_journal_agent` のpromptに明示した公開指示も有効です。「はい」だけ、引用・コード内の文言、否定文は公開指示になりません。実際の人間の発言が公開を拒否している場合は、AIの委譲指示より優先します。
5. メイン側がジョブ単位の公開許可を永続化します。日報エージェントは保存対象を追跡し、公開前にJournalから本文を再取得します。LLMが公開ツールを呼ばなくても、処理の最後に対象下書きを公開します。実際の公開結果と再取得した本文を確認してから、HTML/MarkdownのURLを返します。
6. 確認済み下書きへの外部編集は引き続き更新日時で検出します。競合した場合は最新の下書きを提示し直してください。今回のジョブ内で明示的に修正した場合は、その保存版を公開します。

最初から **「今日の日報を作成して公開して下さい」** と指示しても構いません。事前の下書き提示を必須にはしません。明示的な公開指示がないジョブは下書き保存までです。許可は同じ元の会話・epoch・12時間の日報セッションの当該ジョブだけに限定され、過去の公開指示を次のジョブへ引き継ぎません。公開する記事を特定できない場合、公開用secretが未設定の場合、保存・通信に失敗した場合は、公開成功と報告しません。

公開後の本文編集はできません。人間が手元から記事を削除する方法は [Journalの削除CLI](journal.md#ローカルcliから記事を削除する) を参照してください。削除ツールはMCPにもエージェントにも登録しません。

今回の変更は、先に `apps/journal` でD1マイグレーションを適用してJournal Workerを更新し、続けて `@niao/journal-agent`、`@niao/worker` の順に再デプロイしてください。公開用secretには、Journalと日報専用Workerに同じ `JOURNAL_PUBLISH_TOKEN` が必要です。削除用の追加secretは不要です。

## Cloudflare設定

本変更はデプロイしていません。以下は新規セットアップ時の手順です。既存環境では上記のマイグレーションと3 Workerの更新を行ってください。

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

## クライアントで使用量を確認する

macOSではチャットのグラフボタンまたはメニューバーの「利用状況統計…」、iOSではチャットメニューの「利用状況統計を開く」から「日報」タブを開きます。

- 一覧で日報セッションの開始時刻、累計Neurons、返却値／推定値の区別を確認できます。
- セッションを選ぶと、セッション全体の累計、記録できたNeurons、入力・出力トークン数と推論明細を表示します。
- 推論明細の「ジョブ … の合計」から、1回の指示（jobId）にかかった使用量も確認できます。
- 「更新」で再取得します。「以前のセッションを表示」「さらに明細を表示」でページングします。

不明・実行中・中断・導入前の記録がある場合は、合計を「不明」として記録済み分を別表示します。通信失敗時は前回取得値を残し、別の接続先へ変更した場合は表示を消去します。確認APIだけを読み、AI推論は起動しません。集計範囲は選んだセッション／ジョブの累計であり、アカウント全体の当日使用量や無料枠残量ではありません。

既存のクライアント認証を使用します。使用量APIがデプロイ済みなら、今回の画面追加にWorkerの再デプロイ・追加secretは不要で、macOS／iOSアプリの再ビルドだけで利用できます。

## 日報エージェント単体の使用量API

使用量は日報専用DOの `report_usage_attempts` に推論ごとに記録します。対象は日報エージェントのAI推論分で、MCP・Queue・DO・D1の料金は含めません。UUID、jobId、モデル、ラウンド、開始・終了時刻、状態、トークン数、Neurons、計測方法と適用単価だけを保存し、本文・プロンプト・ツール引数・思考内容・秘密値を含めません。12時間後のコンテクスト消去や元のチャット削除後も使用量は残ります。メインDOの `niao_report_usage_sessions` は、既知の日報セッションIDと開始・期限の索引だけを保持します。

メインWorkerの既存 `NIAO_TOKEN` で認証します。Journal MCP用tokenや追加の分析用secretは不要です。日報Workerには公開HTTP経路を追加せず、メインWorkerから既知セッションだけに読み取りRPCを行います。使用量の取得はAI推論を起動しません。応答はすべて `Cache-Control: no-store` です。

リポジトリで設定済みのメインWorker URLを `NIAO_URL`、既存の認証値を `NIAO_TOKEN` とした例です。

```sh
# 日報セッションの一覧と、それぞれの累計
curl -fsS -H "Authorization: Bearer ${NIAO_TOKEN}" \
  "${NIAO_URL}/agents/niao-agent/personal/journal-usage"

# 1回の指示（受付のjobId）にかかった推論コスト
curl -fsS -H "Authorization: Bearer ${NIAO_TOKEN}" \
  "${NIAO_URL}/agents/niao-agent/personal/journal-usage?jobId=<ジョブUUID>"

# 12時間セッション全体の累計と推論明細
curl -fsS -H "Authorization: Bearer ${NIAO_TOKEN}" \
  "${NIAO_URL}/agents/niao-agent/personal/journal-usage?reportSessionId=<セッションUUID>"
```

一覧と明細は `limit`（既定10、最大20）と `before=<nextCursor>` でページングします。`jobId` と `reportSessionId` は同時に指定できません。未知のIDは404、不正なクエリは400、日報Workerの記録を取得できない場合は503です。一覧で個別の取得に失敗した場合は、そのセッションを `status: unavailable` として返し、0とは扱いません。一覧の開始・期限はepochミリ秒、推論明細の時刻はUTC ISO文字列です。

`summary` の主な項目:

| 項目 | 意味 |
| --- | --- |
| `neurons` | 全推論の取得が完了した場合の累計。未完了・不明分や導入前の未記録ジョブがあればnull |
| `source` | reported / estimated / mixed / no_inference / incomplete |
| `reportedNeurons` | Workers AIのusageにneuronsが含まれる場合の値の累計 |
| `estimatedNeurons` | トークン数と公式単価から計算した推定値の累計 |
| `recordedNeurons` | 現時点で記録できた上記2つの合計。不明・途中の試行があれば全消費量ではない |
| `attempts` | 実行を開始した推論の回数。再実行時の追加推論も加算 |
| `inputTokens` / `outputTokens` | 記録された入力・出力トークンの合計 |
| `incompleteAttempts` | 実行中または途中で切れた推論の数 |
| `unmeasuredAttempts` | Neuronsも換算に必要なトークン数も得られなかった推論の数 |
| `untrackedJobs` | この機能の導入前に完了しており、使用量を記録していないジョブの数 |
| `complete` | 開始済みジョブが終了し、その推論の計測がすべて揃っているか |

ストリームのusageは同一推論内では累積値として上書きし、複数回届いても加算しません。モデルが次の推論へ進んだ場合だけ別の行を作ります。完了済みジョブへのQueue重複配送は推論・使用量とも増やしません。途中で切れた推論は最後のサンプルを残して `interrupted` とし、未取得分をゼロで補いません。推論なしで完了した公開ジョブは0として区別できます。

Gemmaの推定式は、2026-11-03に確認した [Workers AI公式料金表](https://developers.cloudflare.com/workers-ai/platform/pricing/) の係数を使います。

```text
estimatedNeurons = (inputTokens * 9091 + outputTokens * 27273) / 1,000,000
```

係数・確認日・モデルIDも各推論に保存します。これはトークン数からの推定で、Cloudflareの請求・アカウント全体の確定使用量ではありません。既存 `/usage` のアカウント使用量は別の指標です。機能導入前の消費量は復元できず、`trackingSince` より前の完了ジョブは未記録として返します。

このモデル変更と使用量APIだけを反映する場合は、日報専用Worker、メインWorkerの順にデプロイしてください。DO内のテーブルは起動時に追加します。D1変更・追加secret・Journal Workerの再デプロイは不要です。前の削除機能もまだ反映していない環境は、別途そのD1マイグレーションとJournal Workerの更新も必要です。

## 検証

`npm test`、`npm run typecheck`、`npm run build:worker`、`npm run build:journal-agent` を使います。テストではLLMを置き換え、実際のDO SQLite、MCP SDK、JournalのローカルD1で下書き作成・継続・再起動・Queue往復・期限切れを確認します。本番LLMによる生成や本番Queueへの投入、記事の公開は自動テストでは実行しません。

2026-11-03の検証結果: 日報Agent 17件、メインWorker 307件、Journal 22件、削除CLI 2件、Past Logs 39件、importer 13件の計400件が成功しました。全workspaceの型チェック、メイン／日報WorkerのWrangler dry-runも成功しています。使用量APIの認証・ページング・実測値と推定値の区別・未取得値・中断・再起動・12時間後の保持も確認しました。実環境のQueue配線とGemmaの推論・実際のusage応答はデプロイ後の確認事項です。

公式APIの確認先: [Gemma 4 26B A4B](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/)、[Queues limits](https://developers.cloudflare.com/queues/platform/limits/)。
