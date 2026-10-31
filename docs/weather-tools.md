# 天気予報ツールとtools-misc

小さなツールの実装は`apps/tools-misc/`（Worker名`niao-tools-misc`）にまとめます。NiaoAgentは`TOOLS_MISC` Service BindingのWorkerEntrypoint RPC経由で呼び出します。Agent側はLLMのツール定義・引数検証・RPCの薄いアダプターだけを持ち、予報APIのURLやレスポンス解析はサービス側で管理します。既存のRuby Runner、Past Logs、SwiftUI通信プロトコルはそのままです。

## ツール

- `search_weather_locations({query, countryCode?})`: 地名から最大5候補。緯度経度・国・地域・タイムゾーンを返します。`countryCode`はJPなど2文字の国コードです。候補が複数で場所が曖昧ならユーザーに確認します。日本語名で見つからない地名もあり、その場合はTokyo/Fukuokaなどの一般的なローマ字表記で再検索します。表示名は`language=ja`で取得します。
- `get_weather_forecast({latitude, longitude, days?})`: 既知の座標で現在の天気と日別予報を取得します。`days`は既定3・最大7で、現地の今日から始まります。明日なら2日以上を取得します。気温・体感温度・天気コードと説明・最高最低気温・最大降水確率・降水量・風速を含みます。

サービスRPCは`searchWeatherLocations()`と`getWeatherForecast()`です。構造化した`ok`／エラーコード、取得時刻、出典を返します。単位は°C・m/s・mm・%で、欠測値はnullのままです。`timezone=auto`による現地タイムゾーン・UTCオフセット・日付を返すため、相対日付の解釈に使います。現在値はモデルに基づく現在の天気で、ユーザー端末のセンサー観測ではありません。時間別予報・過去天気・位置情報の自動取得は未実装です。

## APIと制限

[Open-Meteo予報API](https://open-meteo.com/en/docs)と[Geocoding API](https://open-meteo.com/en/docs/geocoding-api)の公開HTTPSエンドポイントを使います。APIキーは不要です。個人・非商用で使う無料APIの[利用条件](https://open-meteo.com/en/terms)は10,000回/日未満・5,000回/時・600回/分、CC BY 4.0の帰属表示です。商用利用時には契約・エンドポイント変更を検討してください。回答にはOpen-Meteoへのリンク、位置検索結果の参照時にはGeoNamesの出典を示すようLLMに指示します。

- 任意URLや追加パラメーターは受け付けず、地名と座標のみを検証して固定の外部APIへ送ります。問い合わせた地名／座標はOpen-Meteoへ送信されます。
- 各外部リクエストは8秒、レスポンスは64 KiB、候補5件・予報7日までに制限します。リダイレクトは追従しません。
- 429、接続失敗、タイムアウト、不正なJSONや配列長不一致は安全なエラーコードにします。失敗を晴天や0に置き換えません。
- RPCはAbortSignalを転送しません。Agentは呼び出し前後にキャンセルを確認し、実行中の外部取得はサービスの8秒タイムアウトで終了します。
- サービスはDB・AI・秘密情報のbindingを持たず、公開HTTP入口は404、workers.dev／プレビューURLは無効です。認証済みNiaoAgent経由で利用します。
- ログは操作名・成功失敗・時間・安全なエラーコードだけで、地名・座標・API本文・会話は記録しません。取得結果は信頼しない参照データとしてLLMへ渡します。
- アプリ共通の3ツール呼び出し/ターン制限を使います。天気専用の永続キャッシュや独自レート制限は追加していません。

## ローカル開発と確認

```sh
npm install
npm run dev
```

既存のAgent・Ruby Runnerとtools-miscをWranglerのmulti-workerモードで同時起動します。既存の`apps/worker/.dev.vars`の`NIAO_TOKEN`などはそのまま使い、天気用のsecretは不要です。アプリから「福岡の明日の天気を教えて」「東京の今後3日間の気温と降水確率を調べて」などを送ります。場所が未指定ならユーザーに確認する想定です。既存のツール通知・統計に新しいツール名が表示され、アプリの再ビルドは不要です。

```sh
npm run typecheck -w apps/tools-misc
npm run typecheck -w apps/worker
npm run test -w apps/worker
npm run build:tools
npm run build:worker
```

自動テストの外部HTTPはフィクスチャです。実際のproduction Worker・RPC・AgentのLLMツールループを使い、入力検証、欠測、地名なし、ネットワーク・429・タイムアウト・不正レスポンス・RPC障害・HTTP非公開を確認します。既存Ruby/Past Logs回帰テストも同時実行します。

## デプロイ

**この開発では本番へデプロイしません。** 依存先から順に2つを反映します。

```sh
# リポジトリルート
npm run deploy -w apps/tools-misc
npm run deploy -w apps/worker
```

新しいD1・Queue・secret・課金契約は不要です。AgentのWrangler設定に`TOOLS_MISC → niao-tools-misc`を追加済みです。Ruby RunnerとPast Logsの再デプロイは不要です。tools-miscを先に配置し、Agentからのバインド先を利用可能にしてください。無料APIの稼働保証はなく、一時的な制限・停止時はチャットで取得失敗を伝えます。
