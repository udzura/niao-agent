# Niao

macOS / iPhoneで使えるパーソナル AI コンパニオンの Phase 1。SwiftUI のネイティブチャットと Cloudflare Agents SDK / SQLite Durable Object / Workers AI を接続します。

- メインウィンドウ、メニューバーから開く・フォーカス、入力・送信、逐次表示、エラー・再試行
- サーバーを正とする永続履歴、カーソル同期、送信 ID による重複防止
- [複数会話の保持](docs/sessions.md): 会話一覧・切り替え・名前変更・アーカイブ・明示削除、最終活動から30日で自動削除
- HTTP と WebSocket upgrade の Bearer 認証、macOS Keychain 保存
- 切断時の指数バックオフ、スリープ・復帰、20 秒ごとの履歴照合
- モデル: Gemma 4（既定）/ GLM 4.7 Flash / Granite 4.0 H Micro / Llama 3.3 70B Fast / Llama 4 Scout 17B-16E / Qwen3 30B A3B FP8 / Qwen 3.8 27B を設定画面・APIから切り替え可能
- Gemma 4・Qwen3・Qwen 3.8のthinkingは回答と分離し、「思考過程」から開閉できます。再起動後も確認できます
- 会話単位の削除（共通モデル設定・使用量は保持）。ニュースの自動収集や会話からの長期意味記憶は含みません
- Web Fetch: 既知URLのHTML記事・テキスト・Markdownを取得し、読みやすい本文へ変換（[制限・安全性・デプロイ](docs/web-fetch.md)）
- リマインダー: `set_reminder`で1分〜30日後に同じ会話へ通知（アプリを閉じていても履歴に保存。OSプッシュ通知はありません）
- 非同期Web Fetch: `web_fetch_async`で取得をQueueへ送り、Browser Run `/markdown`で変換後、会話の区切りで要約を追加（[設定・復旧・デプロイ](docs/async-fetch.md)）
- kaniさんの記事: 記事Markdown取得・RSSの最新記事・タイトル部分一致検索（[使い方・デプロイ](docs/kani-tools.md)）
- 天気予報: Open-Meteoの地名検索・現在の天気・最大7日分の予報を`tools-misc` Service Binding経由で取得（[開発・デプロイ手順](docs/weather-tools.md)）
- 制限付きPicoRubyツールで計算・文字列処理（外部I/Oなし）
- Past Logs: 記事・日記のD1保存、日本語/英語キーワード検索・意味検索、読み取り専用MCPをNiaoのツールとして利用（[設定・取り込み・デプロイ](docs/past-logs.md)）
- [Cosense記事の一括インポート](docs/cosense-import.md)（公開ページの一覧・dry-run・途中再開に対応）

## 構成

```text
apps/
  macos/
    Niao.xcodeproj/          # 共有 scheme を含む Xcode プロジェクト
    Niao/                   # SwiftUI / ChatStore / URLSession / Keychain
    Info.plist
    Package.swift           # 通信・同期の Swift 単体テスト用
    Tests/
    Smoke/                  # 実際の URLSession で行う E2E 検証
    scripts/{build,smoke}.sh
  ios/
    Niao.xcodeproj/          # iPhoneターゲット、macos/NiaoのSwiftソースを共有
    Assets.xcassets/         # iOS用の鳥アイコン
    Info.plist
    UITests/
    scripts/{build,test}.sh
  tools-misc/               # 小さなツール用Worker / Service Binding RPC / 天気・kani・Web Fetch
    src/{index,contracts,weather,kani,web-fetch,web-resource,web-extract}.ts
    wrangler.jsonc
  ruby-runner/              # 固定Worker / Service Binding RPC / PicoRuby Wasm
    src/generated/          # 同梱済みJS・Wasm
    wrangler.jsonc
  past-logs/                # 独立Worker / REST管理 / read-only MCP / 日本語FTS5
    src/{index,mcp,documents,search,semantic,embeddings,validation}.ts
    migrations/
    samples/
    scripts/
    test/
    wrangler.jsonc
  worker/
    src/{index,auth,niao-agent,model,model-output,protocol}.ts
    test/
    wrangler.jsonc
    vitest.config.ts
    .dev.vars.example
    package.json
docs/
  past-logs.md
  past-logs-semantic.md
  cosense-import.md
  architecture.md
  protocol.md
  pondro-feedback.md
  verification.md
package.json
package-lock.json
```

## 必要な環境

- macOS 14 以降、Xcode 16 以降（検証: Xcode 27.1 / Swift 6.4、Apple Silicon）
- Node.js 22 以降、npm（検証: Node 26.12.1 / npm 12.2.1）
- Cloudflare アカウント、Workers AI 利用権限、SQLite Durable Objects を利用できる設定

Swift 側に外部ライブラリはありません。Worker の依存バージョンは lockfile に固定しています。

## Worker をローカル起動

リポジトリルートで:

```sh
npm ci
cd apps/worker
npx wrangler login
cp .dev.vars.example .dev.vars
chmod 600 .dev.vars
openssl rand -hex 32
```

生成した値を `.dev.vars` の `NIAO_TOKEN=` に設定します。**`.dev.vars` が既に存在する場合は上書きせず、そのトークンを使用してください。** `.dev.vars` とローカル SQLite の `.wrangler/` は Git 対象外です。

```sh
# リポジトリルートで
npm run dev
```

AgentとRuby Runnerの2つのWorkerが起動し、Agentが `http://127.0.0.1:8787` で待機します。RunnerはService Bindingから利用します。DO と SQLite はローカル、`AI` binding は **実際の Cloudflare Workers AI** に接続するため、ログインとインターネット接続が必要で、推論の利用量が発生します。認証・モデル失敗時に模擬応答へ置き換えることはありません。

Wrangler の同じ作業ディレクトリで起動し続ける限り、再起動後も `.wrangler/state/` に履歴が残ります。ローカル開発は loopback に限定しています。Wrangler の開発用 Local Explorer はアプリの認証境界とは別なので、開発サーバーを公開ネットワークにバインドしないでください。

## macOS アプリを起動

```sh
npm run build:macos
open apps/macos/build/Build/Products/Debug/Niao.app
```

または `apps/macos/Niao.xcodeproj` を Xcode で開き、`Niao` scheme → My Mac → Run。

1. 右上の歯車またはメニューバーの「設定…」を開く。
2. URL に `http://127.0.0.1:8787`、トークンに `.dev.vars` と同じ値を入力する。
3. 「保存して接続」後にメッセージを送信する。通常はEnter、または↑ボタン・Ctrl＋Enterで送信できる。「複数行で入力」を押すと入力欄が広がり、Enterは改行、送信は↑ボタン・Ctrl＋Enterになる。入力済みの文章はモードを切り替えても保持する。従来の⌘Returnでも送信できる。
4. ウィンドウを閉じてもメニューバーの鳥アイコンから再度開ける。終了はメニューの「Niao を終了」。

トークンは接続先ごとに Keychain に保存されます。URL は UserDefaults、送信確認前のメッセージは会話ごとに `~/Library/Application Support/Niao/outbox.json`（0600）に保存します。確定した会話履歴はローカル保存せず、起動時にサーバーから再取得します。トークンをログ・URL・UserDefaults に書き込みません。

本番 URL は HTTPS が必須です。HTTP は localhost / loopback のローカル開発に限ります。HTTP リダイレクトには追従しません。

## iPhone アプリを起動

`apps/ios/Niao.xcodeproj`をXcodeで開き、`Niao` scheme → iPhone 16 Pro → Run。CLIビルドは`npm run build:ios`です。設定で既存AgentのHTTPS URLと`NIAO_TOKEN`を入力すると、Macと同じ会話を利用できます。Face ID / パスコード、統計、Thinking、複数行入力にも対応します。

実機署名・ローカル接続・検証手順は[iOS版の手順](docs/ios.md)を参照してください。この移植によるWorkerの再デプロイは不要です。

## モデル変更・チャットのクリーンアップ

接続後、歯車の設定画面でモデルとThinkingの「自動／常にON／常にOFF」を選び、「モデル設定を保存」を押します。次の会話ターンから適用され、ツール実行後の続きも開始時の設定で完了します。自動ではClef-flashが開始時に1回判定し、曖昧・取得失敗時は既定でONにします。設定はサーバーに保存され、再起動後も保持します。既存ON/OFFは維持し、新規の既定はOFFです。現在はGemma 4に適用し、GLMでは判定を省略します。閾値・曖昧時方針・タイムアウトの調整と計測の詳細は[自動thinking](docs/automatic-thinking.md)を参照してください。

チャット右上のゴミ箱ボタンから、確認後にサーバーの会話履歴を全削除できます。生成中は削除できません。モデル設定と使用量の記録は残り、次の会話に削除済みの文脈は渡りません。削除後の同期に対応するため、Workerとアプリを両方更新してください。

認証付きAPIからも操作できます。具体例と注意点は [モデル設定・履歴削除API](docs/chat-controls.md) を参照してください。

## KeychainアクセスとTouch ID

接続トークンの読み書きの前に、NiaoがTouch IDまたはMacのパスワードで本人確認します。本人確認済み状態は起動中に共有し、スリープ・画面消灯・ユーザーセッション切り替えで失効します。キャンセル後は「再接続」や設定から再試行してください。

Mac版もData Protection Keychainを利用し、Apple Development署名とアプリ専用のaccess groupで保存します。既存トークンは初回読み出し時に移行・検証し、旧項目は保持します。この移行時だけ旧Keychainの許可やパスワード入力が必要になる場合があります。本人確認は引き続きアプリ内のゲートで、項目自体の生体認証ACLは追加しません。[署名・移行・検証手順](docs/keychain-auth.md)を参照してください。

## チャットのMarkdown表示

ユーザー・Niao双方のメッセージと生成中の回答を、基本的なMarkdownとして表示します。`#`形式の見出し、太字・斜体、箇条書き・番号付きリスト、引用、リンク、インラインコード、バッククォート/チルダのコードブロック、区切り線に対応します。コードブロックは改行・インデントを保って横スクロールでき、「コピー」で内容をコピーできます。閉じるフェンスがまだ届いていない生成途中のコードも表示します。

外部ライブラリなしでFoundationのインライン解析とSwiftUIのレイアウトを使います。表・画像・HTML・複雑な入れ子を含む完全なCommonMark/GFM対応ではありません。履歴は元のテキストのまま保存されるので、過去のメッセージにも適用されます。サーバー更新は不要です。

## ツール実行の通知

ツール呼び出しを受信すると、メッセージ領域の右下に「ruby_eval を使用」と一時表示します。3.5秒後に消え、表示中に同じツールが再実行された場合は「×2」のように回数をまとめて表示時間を延長します。通知はクリックやスクロールを遮らず、「視差効果を減らす」設定では移動・拡縮を抑えます。完了通知との二重表示は避けますが、ツール処理の成功を示す通知ではありません。

## 利用状況統計

チャット右上のグラフボタン、またはメニューバーの「利用状況統計…」から開きます。上部で「Neurons／Workers／ツール」を切り替えます。メインのチャット画面には当日のNeurons値と集計範囲だけを表示します。

「Neurons」ではアカウント全体・Niao記録分・Thinking判定の内訳、判定の累計/平均待ち時間、換算値・未取得分、集計日と更新時刻を確認できます。詳細はスクロールでき、開いた時に取得します。「更新」から手動取得も可能です。

「Workers」では当日UTCのアカウント全体のリクエスト数・Durable Objects持続時間を取得し、Free日次枠（100,000リクエスト／13,000 GB-s）と比較します。契約一覧からWorkers Free/Paidを判定し、権限不足時は「未確認」と表示します。既存の`CF_ANALYTICS_TOKEN`に`Account Analytics Read`、プラン確認には追加で`Billing Read`が必要です。この機能はAgent Workerの再デプロイとアプリの再ビルドが必要です。[設定・実取得の確認方法](docs/usage.md#workersとdurable-objectsの日次利用量)を参照してください。

「ツール」では「今回のセッション」と「全体」を切り替え、ツール別の呼び出し・完了通知・完了未確認の回数と、過去セッションの記録を確認できます。Neurons画面へ移動しても集計範囲の選択は保持します。セッションはアプリ起動から終了までで、再接続・スリープ復帰・チャット削除では区切りません。

ツール統計は、このMacが受信した通知のみを集計し、`~/Library/Application Support/Niao/tool-statistics.json`（0600）に日時・ツール名・回数を保存します。接続先をまたいだ累計で、会話本文・Rubyコード・トークン・バックエンドURLは保存しません。導入前やオフライン中の実行は復元できず、完了通知はツール処理の成功を意味しません。サーバーの課金用統計とは別です。ツール統計だけの利用はWorkerの変更・デプロイが不要です。

## Cloudflare 設定とデプロイ

**この実装作業では本番にデプロイしていません。以下は利用者が明示的に実行する手順です。**

`apps/worker/wrangler.jsonc` は次を設定済みです:

- Worker 名 `niao-agent`
- `NiaoAgent` の Durable Object binding
- `v1` migration の `new_sqlite_classes: ["NiaoAgent"]`
- `AI` binding
- 固定Worker `niao-ruby-runner` への `RUBY_RUNNER` Service Binding
- `nodejs_compat` と compatibility date

複数アカウントを使う場合は適切な `account_id` を設定してください。モデルは `src/model.ts` に隔離しています。Workers AI 用の API キーをアプリに渡す必要はありません。

```sh
# リポジトリルートで、Runnerを先に同じアカウントへ配置する
npm run deploy -w @niao/ruby-runner
cd apps/worker
npx wrangler secret put NIAO_TOKEN
# 32 文字以上のランダムな本番専用トークンを対話入力する
npm run deploy
```

新規 Worker で secret put が作成を確認する場合は内容を確認して進めてください。秘密未設定・短すぎる場合、サーバーは 503 で閉じます。公開後、アプリに `https://niao-agent.<your-subdomain>.workers.dev` と本番用トークンを設定します。HTTP と WebSocket の全アプリ API に認証が必要です。`/health` も認証対象です。

```sh
# トークンを環境変数に設定済みの場合の疎通確認
curl -H "Authorization: Bearer $NIAO_TOKEN" "$NIAO_BACKEND_URL/health"
```

Mac版は自身の開発TeamによるApple Development署名を使用します。初回のCLIビルドでは`npm run build:macos -- -allowProvisioningUpdates`でプロファイルの取得・作成を許可できます。配布する場合はDeveloper ID署名とnotarization、Keychain用プロファイルを別途準備してください。

## 日次ニューロン使用量を表示する

Cloudflare の **Account → Account Analytics → Read** 権限を持つ専用 API トークンを作成し、Worker に `CF_ACCOUNT_ID` と `CF_ANALYTICS_TOKEN` を設定すると、アカウント全体の使用量を取得します。アプリ側の `NIAO_TOKEN` はそのまま使用します。

```sh
cd apps/worker
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_ANALYTICS_TOKEN
npm run deploy
```

日次は UTC 基準（日本時間 9:00 リセット）です。未設定・取得失敗時には「Niao 記録分」を区別して表示します。具体的なトークン作成、ローカル設定、GraphQL クエリ、エラーの確認方法は [使用量の設定手順](docs/usage.md) を参照してください。

## Rubyツール

Gemma / GLMが必要に応じて`ruby_eval`を呼び、計算結果を使って回答します。例えば「Rubyで1から100までの二乗の和を計算して」と依頼できます。アプリには実行中の表示が出ます。

専用の固定Worker `niao-ruby-runner` をService Binding RPCで呼びます。Worker Loaderへの依存はなく、追加シークレットも不要です。Rubyへネットワーク・ファイル・環境変数を渡さず、命令数・Wasmメモリ・出力を制限します。ただし、同期C処理を強制中断するアプリ側の仕組みはありません。

軽量処理はローカルで動作確認済みですが、Freeプランの10ms CPU制限に対する本番動作は未確認です。Runnerを先に、次にAgentをデプロイしてください。今回の移行によるアプリの更新は不要です。具体的な制約、計測結果、ローカル開発・デプロイ手順は [Rubyツール](docs/ruby-tool.md) を参照してください。

## アプリアイコン

オリジナルの鳥の SVG を `apps/macos/Artwork/Niao.svg` に保存しています。PNG の各解像度もリポジトリに含まれるため、通常のビルドに画像ツールは不要です。SVG を変更した場合は ImageMagick を入れて `python3 apps/macos/scripts/generate-icon.py` で再生成できます。既存のメニューバーの SF Symbols は UI 内で使用し、Dock のアプリアイコンには独自の図形を使用しています。[Apple の SF Symbols 利用案内](https://developer.apple.com/design/human-interface-guidelines/sf-symbols)

## テスト・検証

```sh
npm run typecheck
npm test                         # workerd の実 Agent / SQLite。モデルのみテスト用 fixture
npm run build:runner             # Ruby Runnerのdry-run
npm run bench:ruby               # ローカルCPU計測（AIを呼ばない）
npm run build:worker             # wrangler deploy --dry-run。アップロードしない
npm run build:macos
swift test --package-path apps/macos
npm audit
```

実モデル E2E は起動済み Worker とトークンを指定します:

```sh
export NIAO_BACKEND_URL=http://127.0.0.1:8787
# NIAO_TOKEN を .dev.vars と同じ値に設定する（履歴・ログに残さない方法を使用）
bash apps/macos/scripts/smoke.sh
```

挨拶を 1 件送信し、逐次表示・HTTP 同期・再接続・重複排除を検証します。実際の推論利用量が発生します。出力には ID と件数だけを表示し、トークンと会話内容は表示しません。出力された request ID を引数にすると、同じ送信の再試行を検証でき、正常完了済みなら追加推論を実行しません:

```sh
# Worker を停止・再起動した後
bash apps/macos/scripts/smoke.sh <previous-request-id>
```

詳しい実行結果・未確認項目は [検証記録](docs/verification.md)、設計は [architecture.md](docs/architecture.md)、通信仕様は [protocol.md](docs/protocol.md) を参照してください。

Cosenseの定期同期・Queue・初回同期の設定は [自動同期](docs/cosense-sync.md) を参照してください。

## バージョン管理

リリースバージョンは`0.1.20261101`のような`MAJOR.MINOR.YYYYMMDD`形式です。`version.json`を共通の元データとし、更新には次を使います。

```sh
npm run version:set -- 0.1.20261102
```

AgentのAPIは`version.json`を直接参照し、コマンドはmacOS / iOSのDebug・Release両方の`MARKETING_VERSION`も更新します。引数を省略すると現在の`version.json`へアプリ設定を再同期します。日付はリリース日であり、起動やビルドのたびには変わりません。

アプリの設定画面にアプリ自身と接続先サーバーのバージョンを表示します。切断中のサーバー値は前回取得値と表示し、旧サーバーが値を返さない場合も接続できます。認証付き`GET /health`の`version`、モデル設定APIの`serverVersion`からも取得できます。通信プロトコル番号`v:1` / `protocol:1`はリリースバージョンと独立しています。

反映にはAgentの再デプロイとアプリの再ビルドが必要です。`CFBundleVersion`（Xcodeの`CURRENT_PROJECT_VERSION`）は配布用のビルド番号として独立して保持します。同じリリースを再配布するときは必要に応じてビルド番号も増やしてください。
