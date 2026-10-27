# Niao

macOS に住むパーソナル AI コンパニオンの Phase 1。SwiftUI のネイティブチャットと Cloudflare Agents SDK / SQLite Durable Object / Workers AI を接続します。

- メインウィンドウ、メニューバーから開く・フォーカス、入力・送信、逐次表示、エラー・再試行
- サーバーを正とする永続履歴、カーソル同期、送信 ID による重複防止
- HTTP と WebSocket upgrade の Bearer 認証、macOS Keychain 保存
- 切断時の指数バックオフ、スリープ・復帰、20 秒ごとの履歴照合
- モデル: `@cf/zai-org/glm-4.7-flash`。ニュース収集、ツール、定期実行、長期記憶は含みません

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
  worker/
    src/{index,auth,niao-agent,model,protocol}.ts
    test/
    wrangler.jsonc
    vitest.config.ts
    .dev.vars.example
    package.json
docs/
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

`http://127.0.0.1:8787` で待機します。DO と SQLite はローカル、`AI` binding は **実際の Cloudflare Workers AI** に接続するため、ログインとインターネット接続が必要で、推論の利用量が発生します。認証・モデル失敗時に模擬応答へ置き換えることはありません。

Wrangler の同じ作業ディレクトリで起動し続ける限り、再起動後も `.wrangler/state/` に履歴が残ります。ローカル開発は loopback に限定しています。Wrangler の開発用 Local Explorer はアプリの認証境界とは別なので、開発サーバーを公開ネットワークにバインドしないでください。

## macOS アプリを起動

```sh
npm run build:macos
open apps/macos/build/Build/Products/Debug/Niao.app
```

または `apps/macos/Niao.xcodeproj` を Xcode で開き、`Niao` scheme → My Mac → Run。

1. 右上の歯車またはメニューバーの「設定…」を開く。
2. URL に `http://127.0.0.1:8787`、トークンに `.dev.vars` と同じ値を入力する。
3. 「保存して接続」後にメッセージを送信する。⌘Return でも送信できる。
4. ウィンドウを閉じてもメニューバーの鳥アイコンから再度開ける。終了はメニューの「Niao を終了」。

トークンは接続先ごとに Keychain に保存されます。URL は UserDefaults、送信確認前のメッセージ 1 件だけは `~/Library/Application Support/Niao/outbox.json`（0600）に保存します。確定した会話履歴はローカル保存せず、起動時にサーバーから再取得します。トークンをログ・URL・UserDefaults に書き込みません。

本番 URL は HTTPS が必須です。HTTP は localhost / loopback のローカル開発に限ります。HTTP リダイレクトには追従しません。

## Cloudflare 設定とデプロイ

**この実装作業では本番にデプロイしていません。以下は利用者が明示的に実行する手順です。**

`apps/worker/wrangler.jsonc` は次を設定済みです:

- Worker 名 `niao-agent`
- `NiaoAgent` の Durable Object binding
- `v1` migration の `new_sqlite_classes: ["NiaoAgent"]`
- `AI` binding
- `nodejs_compat` と compatibility date

複数アカウントを使う場合は適切な `account_id` を設定してください。モデルは `src/model.ts` に隔離しています。Workers AI 用の API キーをアプリに渡す必要はありません。

```sh
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

このビルドは個人の開発用 ad-hoc 署名です。配布する場合は Developer ID 署名と notarization を別途行ってください。

## テスト・検証

```sh
npm run typecheck
npm test                         # workerd の実 Agent / SQLite。モデルのみテスト用 fixture
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
