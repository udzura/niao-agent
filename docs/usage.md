# Workers AI の日次ニューロン使用量

Niao は Cloudflare の公式 GraphQL Analytics API を Worker から呼び、アカウント全体の当日使用量を表示できます。macOS アプリには Cloudflare API トークンを渡しません。既存の `NIAO_TOKEN` で Niao の API にアクセスします。

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

更新された Niao アプリで再接続し、使用量欄の更新ボタンを押します。**「今日 (UTC) · アカウント全体」** と表示されれば取得成功です。新しいアイコン・使用量欄を取り込む場合は、アプリを終了して `npm run build:macos` 後に起動し直してください。

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
- 全体を取得できない場合は **「Niao 記録分」** を表示します。推論レスポンスの `usage.neurons` を SQLite に保存した合計です。記録機能導入後の Niao の呼び出しだけであり、過去や他のアプリの利用量は復元しません。
- モデルが `usage.neurons` を返さなかった呼び出し、失敗・中断・実行中の呼び出しは「使用量未取得」として件数を表示します。推定値を勝手に足すことはありません。
- 同じ完了済みメッセージの再送は加算しません。失敗後に新しい推論を実行した場合は別の呼び出しとして記録します。繰り返し届く累積 usage フレームは二重加算しません。
- Niao 記録分は推論開始日の UTC 日付に帰属します。日付をまたぐ推論や途中で usage を得られない場合、アカウント集計と一致するとは限りません。
