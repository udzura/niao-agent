# Workers AI の日次ニューロン使用量

Niao は Cloudflare の公式 GraphQL Analytics API を Worker から呼び、アカウント全体の当日使用量を表示できます。macOS アプリには Cloudflare API トークンを渡しません。既存の `NIAO_TOKEN` で Niao の API にアクセスします。

メイン画面は当日の値と集計範囲のみを表示します。グラフボタン、またはメニューバーの「利用状況統計…」から開き、「Neurons」で内訳・Thinking判定の待ち時間・取得エラー・集計日時を確認できます。同じウィンドウから「ツール」の統計へ切り替えられます。

統計画面では、日次無料枠10,000 Neuronsに対する使用率をバー表示し、75%以上で橙、90%以上で赤に変わります。100%を超えた割合も表示します。アカウント全体が取得できた場合だけ残りの目安（超過時は超過量）を表示し、Niao記録分しかない場合は全体の残量を算出しません。前の集計日の値は明示します。Paidプランの上限を示すグラフではありません。Niao記録分に占めるThinking判定の割合も表示します。

ツール画面は呼び出し数の多い順の横棒グラフで、完了通知あり／未確認を色分けします。今回のセッション／全体の切り替えを維持し、全体では直近10セッションの回数も比較できます。棒の番号は古い順で、開始日時は下の一覧に表示します。完了通知は処理が戻った通知で、ツール自体の成功率ではありません。表示はSwiftUI・Swift Chartsを使用し、外部のUI依存や新しいサーバーAPIは追加しません。

Workers／Durable Objectsの統計は[下記](#workersとdurable-objectsの日次利用量)を参照してください。

## 1. Analytics 読み取り用トークンを作る

Cloudflare ダッシュボードの **Account API tokens** で **Create Token → Custom token / Get started** を選びます。

- 名前の例: `Niao usage reader`
- 権限: **Account → Account Analytics → Read**
- 対象: Niao が利用している Cloudflare アカウント（リソース選択欄がある場合は対象アカウントのみに限定）

確認後にトークンを作成してコピーします。既存の `NIAO_TOKEN` とは別物です。Workers AI の推論権限だけを持つトークンでは、Analytics の読み取りが許可されない場合があります。

公式手順: [Configure an Analytics API token](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)

実装時の調査では既存 Wrangler ログインで GraphQL スキーマと集計を読み取り確認しましたが、その OAuth トークンを Worker に保存したわけではありません。継続運用には上記の専用トークンを設定してください。

## 2. アカウント ID を確認する

対象アカウントの Account ID（32 桁の英数字）をコピーします。Zone ID や Worker 名ではありません。

CLI からも確認できます:

```sh
cd /Users/udzura/ghq/github.com/udzura/niao-agent/apps/worker
npx wrangler whoami
```

出力の **Account ID** を使用します。Wrangler のデプロイ先 `account_id` と、アプリが Analytics を読む `CF_ACCOUNT_ID` は別の設定項目です。通常は同じアカウント ID を指定します。

## 3. 本番 Worker に設定する

以下は本番設定を書き換えるコマンドです。トークンや ID は、それぞれ実行後の対話プロンプトに入力します。

```sh
cd /Users/udzura/ghq/github.com/udzura/niao-agent/apps/worker
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_ANALYTICS_TOKEN
npm run deploy
```

`CF_ACCOUNT_ID` は秘密情報ではありませんが、ここでは設定方法を揃えるため secret として保存します。`CF_ANALYTICS_TOKEN` には手順 1 のトークンを入力します。`NIAO_TOKEN` の変更は不要です。`wrangler secret put` 自体も現在の Worker のデプロイを更新する操作です。

更新された Niao アプリで再接続し、「利用状況統計」→「Neurons」の「更新」を押します。**「今日 (UTC) · アカウント全体」** と表示されれば取得成功です。アプリの更新を取り込む場合は、アプリを終了して `npm run build:macos` 後に起動し直してください。

## ローカル Worker に設定する場合

`apps/worker/.dev.vars` の既存 `NIAO_TOKEN` を残し、次の 2 行を追加します（Git 対象外）:

```dotenv
CF_ACCOUNT_ID=対象アカウントのID
CF_ANALYTICS_TOKEN=Analytics読み取り用トークン
```

Worker を再起動します。**本番 secret を登録してもローカルの `.dev.vars` には反映されず、その逆も同様です。** アプリのバックエンド URL が localhost なのか本番 URL なのかも確認してください。

## 実際に呼ぶ API

エンドポイント: `POST https://api.cloudflare.com/client/v4/graphql`

ヘッダー: `Authorization: Bearer <CF_ANALYTICS_TOKEN>`、`Content-Type: application/json`

ボディは `query` と `variables` を持つ JSON です。実装中のクエリ:

```graphql
query NiaoDailyUsage($account: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: {accountTag: $account}) {
      aiInferenceAdaptiveGroups(
        limit: 1
        filter: {datetime_geq: $start, datetime_lt: $end}
      ) {
        sum { totalNeurons }
      }
    }
  }
}
```

`account` はアカウント ID、`start` は当日 UTC 0:00 の ISO 8601 日時、`end` は現在時刻です。日付・モデルなどの dimensions を指定せず、対象期間の全モデルの合計を 1 行で取得します。HTTP 200 でも GraphQL の `errors` がある場合は成功として扱いません。

macOS アプリが使う Niao 側の API は **`GET /agents/niao-agent/personal/usage`** です。こちらの Authorization には **`NIAO_TOKEN`** を使用します。レスポンスの `account.status` が `available` なら `account.neurons` がアカウント全体の値です。

## 集計の意味と取得できない場合

- 集計日は UTC 0:00〜24:00。日本時間は **9:00〜翌日 9:00** です。[Cloudflare の料金・リセット時刻](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- アカウント全体には他の Worker・アプリ・モデルの使用量も含まれます。Analytics の反映遅延やサンプリングがあり、確定請求額や厳密な残りクォータではありません。
- 成功した全体集計は最大 60 秒キャッシュします。手動更新もこのキャッシュを使用します。エラーは 15 秒で再取得可能になります。
- `not_configured`: ID または Analytics トークンが未設定です。
- `unavailable`: ID、権限、トークンの有効期限、ネットワークなどを確認してください。失敗を使用量 0 として表示しません。権限追加時はトークンが対象アカウントをカバーしているかも確認してください。
- 全体を取得できない場合は **「Niao 記録分」** を表示します。通常の推論レスポンスの `usage.neurons` と、自動thinkingのjudge使用量をSQLiteで合算します。judgeの公式レート換算を含む場合は **「Niao 記録・換算分」** と表示します。記録機能導入後のNiaoだけで、過去や他のアプリの利用量は復元しません。
- 通常の回答モデルが `usage.neurons` を返さなかった呼び出し、失敗・中断・実行中の呼び出しは「使用量未取得」として件数を表示します。Clef-flashのjudgeは実際に返る `input_tokens` と公式レートから換算します。判定の内訳、累計/平均待ち時間、換算根拠は[自動thinking](automatic-thinking.md#neuronsと待ち時間)を参照してください。時間をNeuronsに変換せず、アカウント全体へjudgeを二重加算しません。
- 同じ完了済みメッセージの再送は加算しません。失敗後に新しい推論を実行した場合は別の呼び出しとして記録します。繰り返し届く累積 usage フレームは二重加算しません。
- Niao 記録分は推論開始日の UTC 日付に帰属します。日付をまたぐ推論や途中で usage を得られない場合、アカウント集計と一致するとは限りません。

## 本番での取得エラーを調べる

`analytics_unavailable`だけでは原因を区別できなかったため、診断コードと`analytics.error`構造化ログを追加しました。Agentのみ再デプロイ後、先にログ接続を開始してください。

```sh
# リポジトリルート
npm run deploy -w @niao/worker
cd apps/worker
npx wrangler tail niao-agent --format pretty
```

別ターミナルから、アプリと同じバックエンドへ取得リクエストを送ります。

```sh
curl --silent --show-error \
  -H "Authorization: Bearer $NIAO_TOKEN" \
  "$NIAO_BACKEND_URL/agents/niao-agent/personal/usage" | jq '.account'
```

失敗結果は15秒キャッシュされます。ログが出ない場合は15秒以上待って再度取得してください。`phase`はconfiguration/fetch/decode/graphql、`httpStatus`は上流HTTPステータス（取得できた場合）、`errorType`と`message`は例外の種類と伏字済みメッセージです。トークン、Account ID、ヘッダー、スタック、上流レスポンス本文は記録しません。

- `analytics_http_401` / `analytics_http_403`: 上流がHTTPで拒否。
- `analytics_timeout`: タイムアウト・中断。
- `analytics_fetch_failed`: fetchまたは実行時例外。ログのmessageを確認。
- `analytics_invalid_json`: JSONデコード失敗。
- `analytics_rejected`: GraphQL errorsあり。

修正後のAPIで引き続き`analytics_unavailable`が返る場合は、旧バージョン・別URL・キャッシュの可能性を確認してください。前のfetch receiver修正だけで本番の問題が解消したことは未確認です。診断ログを取得して原因を特定します。

Workersのfetchは`redirect:"error"`を受け付けません。Analyticsは`redirect:"manual"`とし、3xxも非成功レスポンスとして拒否します。`analytics_fetch_failed`のログに`Invalid redirect value`がある場合は、この互換性修正を含むAgentをデプロイしてください。

## WorkersとDurable Objectsの日次利用量

「利用状況統計」→「Workers」で、今日のUTC 0:00から現在までのアカウント全体の目安を表示します。Niao以外のWorkerも含みます。過去の日別履歴は保存しません。

| 指標 | 公式GraphQLデータセット／フィールド | 比較するFree日次枠 |
|---|---|---|
| Workers & Pages Functionsのリクエスト | `workersInvocationsAdaptive.sum.requests` | 100,000リクエスト |
| Durable Objectsの持続時間 | `durableObjectsPeriodicGroups.sum.duration` | 13,000 GB-s |

`duration`はすでにGB-sです。`activeTime`（マイクロ秒）やCPU時間と混同せず、リクエストごとのwall timeも合計しません。持続時間は無料枠内の消費も含み、無料枠超過分だけを表す数値ではありません。Pagesの静的ファイルへのアクセスは含みません。Analyticsのリクエスト集計は課金・制限の厳密なカウンターではなく、内部呼び出しなどの扱いや反映遅延・サンプリングによりダッシュボードの請求用値と異なる場合があります。

棒はFree枠を比較基準にしており、実際の残量保証ではありません。Paidの枠は月次のため、Paidと判定した場合は日次の比較バーが契約上限ではない旨を表示します。日付が変わった古い値は「前回の集計日」と表示します。

### 権限とFreeプランの確認

利用量には既存の`CF_ACCOUNT_ID`と`CF_ANALYTICS_TOKEN`を使用します。トークンの権限は対象アカウントの **Account → Account Analytics → Read** です。プランの自動確認には、同じトークンへ **Account → Billing → Read** を追加してください。書き込み権限は不要です。ローカル設定は`apps/worker/.dev.vars`、本番はWrangler secretsで管理します。

プラン確認は公式の`GET /accounts/{account_id}/subscriptions`を使います。完全な契約一覧に有効なWorkers有料契約がない場合にWorkers Freeと推定します。`WORKERS_PAID`などの有効なWorkers契約があればPaidです。ゾーンのFree/Pro契約はWorkersのプラン判定に使いません。解約済みでも支払期間が残っていればPaidとして扱います。未知のWorkers契約・一覧の取得不完了・403などのエラーは「未確認」にし、Freeと断定しません。画面からCloudflareのWorkers & Pagesへ移動して確認することもできます。

`Billing Read`がない場合でも利用量は表示できます。プラン欄の`analytics_http_403`と権限の案内を確認してください。Billing情報そのものやAPIトークンはアプリへ返しません。

公式資料: [Workers GraphQL](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)、[DO Analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)、[契約一覧APIと必要権限](https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/)、[Workers契約ID](https://developers.cloudflare.com/tenant/reference/subscriptions/)、[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)、[DO料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)。

### ローカルのトークンで実取得を確認する

リポジトリルートから実行します（Node.js 22以降、`npm install`済み）。本番Workerをデプロイせずに、実装と同じクエリ・解析処理を使って公式APIを読み取ります。

```sh
node tools/check-platform-usage.mjs
```

環境変数を優先し、未指定時はGit対象外の`apps/worker/.dev.vars`から`CF_ACCOUNT_ID`と`CF_ANALYTICS_TOKEN`だけを使用します。出力は使用量・プラン判定・安全なエラーコードで、トークンやAccount IDは表示しません。いずれか取得不可なら終了コード1ですが、取得できた他の指標も表示します。

2026-10-30の実確認では、既存のAnalyticsトークンでリクエスト数とDO持続時間を取得できました。契約一覧は当初403でしたが、同じトークンへのBilling Read追加後に取得でき、有効なWorkers有料契約なしからFreeと判定できました。

### 本番への反映

同じトークンの権限だけを編集した場合は、secretの値を再登録する必要はありません。トークンを再発行した場合だけ、先に更新します。

```sh
cd apps/worker
# トークンを再発行した場合のみ（対話入力）:
npx wrangler secret put CF_ANALYTICS_TOKEN
# Agent Workerだけをデプロイ:
npm run deploy
```

Ruby RunnerとPast Logsの再デプロイは不要です。macOSアプリは再ビルドし、起動し直してください。

```sh
# リポジトリルートで:
npm run build:macos
open apps/macos/build/Build/Products/Debug/Niao.app
```

アプリの出力先は`apps/macos/scripts/build.sh`に従います。デプロイ後のAPI確認:

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $NIAO_TOKEN" \
  "$NIAO_BACKEND_URL/agents/niao-agent/personal/platform-usage" | jq .
```

APIは既存と同じ認証を要求し、GETのみ許可します。`workers.requests`、`durableObjects.durationGbSeconds`、`plan.name`（`free`／`paid`／取得不可時`null`）を返し、それぞれに`status`、`queriedAt`、`errorCode`があります。各指標は独立して取得し、利用量は成功60秒・失敗15秒、プランは成功1時間・失敗15秒キャッシュします。APIの`asOf`はレスポンスの集計時刻で、実際の上流取得時刻は各`queriedAt`です。プラン権限追加直後の失敗キャッシュは15秒後に失効します。
