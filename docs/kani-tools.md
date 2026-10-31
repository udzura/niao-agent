# kaniさんの記事ツール

`niao-tools-misc`に3つの読み取り専用RPCを追加しています。NiaoAgentは既存の`TOOLS_MISC` Service Bindingから呼びます。記事や一覧を読む機能で、kaniさんへのメッセージ送信や記事編集は行いません。

| LLMツール | サービスRPC | 用途 |
|---|---|---|
| `get_kani_article({url, offset?})` | `getKaniArticle()` | 指定記事のMarkdown本文を読む |
| `get_latest_kani_article({includeArticle?})` | `getLatestKaniArticle()` | RSSから最新1件。既定では本文も読む |
| `search_kani_articles({query, limit?})` | `searchKaniArticles()` | 一覧のタイトルから文字列一致で提案 |

## 動作

- 記事URLは`https://yota.kani.show/e1100/`形式のみ許可します。`index.md`も受け付け、正規URLにそろえます。外部URL・クエリー・フラグメント・任意パスは受け付けません。
- 記事とトップページは`Accept: text/markdown`で取得し、HTMLへのフォールバックはエラーにします。
- 記事取得は見出し・公開日（存在する場合）・正規URL・Markdownを返します。要約と感想の生成は既存のAgent内LLMが担当します。記事を簡潔に要約し、感想を一言、著者の記述と区別して添え、元URLをリンクするようsystem guidanceとツール説明へ追加しました。
- 最新記事は`https://yota.kani.show/feed.xml`のRSSをXMLパーサーで読み、公開日時が最新の有効な記事を選びます。フィードの先頭順には依存しません。既定の`includeArticle=true`では単独記事取得と**同じ本文読み取り関数**へ委譲します。`false`ならタイトル・URL・日時だけを取得します。
- タイトル検索はトップページのMarkdownから記事行を抽出し、Unicode NFKC正規化・英字大小文字無視の部分一致を行います。本文・一覧の抜粋は検索しません。既定5件、最大20件で、タイトル・日付・URL・合計一致数・残りの有無を返します。意味検索・正規表現・複数語AND検索ではありません。内容を要約する場合は選んだ記事を別途取得します。
- 本文は1回16,000 Unicode文字までです。`truncated`・`nextOffset`・`totalCharacters`を返し、続きは同じ記事ツールの`offset=nextOffset`で取得します。途中までの場合に全文を読んだと断定しないよう指示します。Agent共通の3ツール呼び出し/ターン制限はそのままです。

`yota.kani.show`を含む現在のユーザーメッセージでは、URLだけの場合も含めて、回答前に必ずツールを呼ぶようsystemプロンプトで強く指示します。記事URLは本文取得、トップ・feed.xmlは最新記事取得、タイトル検索の依頼は検索ツールに対応付けます。過去の会話や記憶だけでの回答、取得を試さず「Webを開けない」と答えることを禁止します。取得失敗はそのまま伝えます。これはLLMへの指示であり、コードによる強制ルーティングではありません。

## 制限と安全性

外部取得は各8秒、記事・一覧は各256 KiB、RSSは1 MiB・1,000記事までです。最新記事＋本文取得は最大2外部リクエストです。リダイレクトは追従せず、RSS中の外部リンクは取得しません。DOCTYPE・ENTITY宣言を拒否します。404・429・不正なレスポンス・タイムアウトは固定エラーコードで返し、記事を捏造しません。

本文・タイトル・フィードは信頼しない参照データです。本文中の命令をsystem指示として扱わず、外部リンクへの追加アクセスやコード実行もしません。ログは操作名・成否・所要時間・固定エラーコードのみです。新しいsecret、保存先、定期アクセスはありません。

記事を全文転載するのではなく、ユーザーの依頼に応じて簡潔な概要とNiaoの感想を返す設計です。実際の応答文とツール選択はLLMによるため、プロンプトの遵守は絶対保証ではありません。

## 開発・デプロイ

リポジトリルートから:

```sh
npm install
npm run dev
npm run typecheck -w apps/tools-misc
npm run typecheck -w apps/worker
npm run test -w apps/worker
npm run build:worker
```

試すメッセージ:

- 「kaniさんの https://yota.kani.show/e1100/ を読んで、概要と感想を教えて」
- 「kaniさんの最新記事を読んで」
- 「kaniさんのタイトルに『制約』が入る記事を探して」

本番は依存先から順に反映してください。この実装作業ではデプロイしません。

```sh
npm run deploy -w apps/tools-misc
npm run deploy -w apps/worker
```

既存の`TOOLS_MISC`バインドを共用します。アプリ再ビルド、新しいsecret、Ruby Runner／Past Logsの再デプロイは不要です。既存のツール通知・利用統計にも3ツールの名前が表示されます。

自動テストは架空の短い記事・一覧・RSSでHTTPだけを置換し、実際のproduction WorkerとService Binding、サーバー側のLLMループまで検証します。要約生成テストのモデル出力は明示的なフィクスチャで、実際のモデルによる要約品質の評価ではありません。
