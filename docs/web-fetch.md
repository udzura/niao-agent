# Web Fetch

後から要約を届ける非同期版`web_fetch_async`も利用できます。[非同期基盤・Queue作成・クライアント更新](async-fetch.md)を参照してください。取得・抽出の制限は同期版と共通です。

`web_fetch({"url":"https://example.com/article"})`は、既知の公開URLを読み、記事本文をMarkdownで返すツールです。URLを探す`web_search`ではありません。Niaoで「このURLを読んで要約して」のように依頼します。kaniの記事は引き続き専用ツールを優先します。

## 構成

```text
NiaoAgent → tools-misc Service Binding.webFetch({url})
          → URL / DNS検査 → native fetch（手動redirect）
          → Content-Type判定
          → LinkeDOM → Mozilla Readability → Turndown → 長さ制限
          → untrusted_reference_dataとしてモデルに返す
```

実装は`apps/tools-misc/src/web-resource.ts`（ネットワーク・制限）、`web-extract.ts`（抽出・正規化）、`web-fetch.ts`（RPCサービスの結果・ログ）に分けています。Agent側は既存の`misc-tools.ts`へ薄いアダプターを追加しています。SwiftUI、WebSocket、履歴、Ruby Runner、MCPの変更は不要です。

ライブラリは`@mozilla/readability 0.6.0`、`linkedom 0.18.14`の`linkedom/worker`エントリー、`turndown 7.2.4`。`nodejs_compat`と互換日付2026-10-27を設定した実際のworkerdでテストしています。DOMをそのままReadabilityのserializerからTurndownへ渡し、抽出HTMLを再パースしません。ブラウザのDOMやグローバル`window`は用意しません。Turndownには文字列を渡さずDOMを渡します。

`turndown-plugin-gfm`はLinkeDOMにない`HTMLTableElement.rows`を参照するため採用していません。小さな変換ルールで、見出し行のある単純な表をGFMへ変換します。見出しなし・結合セルのある表はセルの内容を行単位のテキストへ落とします。画像、スクリプト、CSS、ナビゲーション、サイドバー、フッター、フォームは除きます。JSON-LD解析は無効にし、タイトル・author・descriptionなどの通常のメタ情報はReadabilityから取得します。

参考: [Mozilla Readability](https://github.com/mozilla/readability)、[LinkeDOMのWorkerエントリー](https://github.com/WebReflection/linkedom)、[Turndown](https://github.com/mixmark-io/turndown)。

## 入出力

入力は`url`のみ。認証ヘッダー・Cookie・任意ヘッダーは受け付けません。Service Bindingだけに公開し、WorkerのHTTPルートは引き続き404です。

成功例:

```json
{
  "ok": true,
  "url": "https://example.com/start",
  "finalUrl": "https://example.com/article",
  "title": "Article title",
  "byline": "Author",
  "excerpt": "Short description",
  "content": "## Heading\n\nArticle body...",
  "contentType": "text/html",
  "truncated": false
}
```

`url`は入力の正規化URL、`finalUrl`はリダイレクト後に実際に取得したURLです。取得URLのfragmentは除きますが、本文中のリンクのfragmentは保持します。モデルには`{"untrusted_reference_data":true,"result":...}`で渡し、引用には`finalUrl`を使うよう指示します。メタデータも含めて参照データとして扱い、命令として実行しません。抽出した指示文を完全に無害化する仕組みではなく、モデル側の命令境界と既存ツールの制限を併用します。

対応Content-Typeは`text/html`、`text/plain`、`text/markdown`、`text/x-markdown`。後者3種はHTML抽出をせず、改行の正規化・長さ制限を適用します。空行の整理でコードフェンス内の空行やインデントは潰しません。本文の文字コードはContent-Typeのcharsetに従い、未指定はUTF-8。デコーダー非対応の文字コードや不正なバイト列はエラーです。

PDF、画像、バイナリ、不明なContent-Typeは`web_fetch_unsupported_content_type`です。OCRやPDF抽出はしません。空本文、記事が見つからないHTMLはそれぞれ`web_fetch_empty_content` / `web_fetch_extraction_failed`です。短いページは最低文字数で弾かず、抽出できれば返します。本文を捏造するフォールバックはありません。

## 設定と制限

`apps/tools-misc/wrangler.jsonc`の非機密`vars`で調整します。ツール入力から上書きはできません。

| 設定 | 初期値 | 設定可能範囲 |
|---|---:|---:|
| `WEB_FETCH_TIMEOUT_MS` | 8,000 ms | 100–45,000 |
| `WEB_FETCH_MAX_REDIRECTS` | 3 | 0–5 |
| `WEB_FETCH_MAX_DOWNLOAD_BYTES` | 32,768 bytes（32 KiB） | 1,024–2,097,152 |
| `WEB_FETCH_MAX_CONTENT_CHARS` | 12,000 UTF-16単位 | 100–32,000 |
| `WEB_FETCH_MAX_RESULT_BYTES` | 32,768 bytes（32 KiB） | 8,192–262,144 |
| `WEB_FETCH_MAX_DOM_ELEMENTS` | 300 | 100–10,000 |
| `WEB_FETCH_MAX_DOM_DEPTH` | 48 | 8–96 |

タイムアウトはDNS・全redirect・本文読み取りを通じて1回の期限です。Content-Lengthを確認し、さらに本文ストリームを数えて上限を超えた時点でキャンセルします。ダウンロード超過はエラーにし、途中までのHTMLを記事全体として扱いません。

抽出後の長い本文は、サロゲートペアを壊さず切り詰め`truncated:true`を返します。JSONのエスケープ、日本語UTF-8のサイズ、Agentの参照データラッパーも含めて結果サイズを制限します。切り詰め位置でMarkdownのフェンスやリンクが途切れる場合があります。メタデータだけで指定上限を超える場合は`web_fetch_result_too_large`です。

DOMには要素数・全ノード数・深さの上限を設けます。JavaScriptのタイマーで同期DOM処理を途中停止することはできません。CPU制限を超えた場合はWorkersランタイムが中断します。

## ネットワークの安全性と限界

- HTTP / HTTPSのみ、標準ポート80 / 443のみ。HTTPSからHTTPへのredirectは拒否。
- URL中のユーザー名・パスワード、制御文字・バックスラッシュを拒否。
- localhost、単一ラベル、`.local` / `.internal`などの内部用・予約ドメイン、metadataホスト名を拒否。
- `ipaddr.js`でIPを分類し、private / loopback / link-local / CGNAT / multicast / reserved / IPv4-mapped・トンネル系IPv6などを拒否。IPv6は通常のglobal unicastに限定。Azureの仮想内部IPも明示拒否。
- ドメインは固定のCloudflare DoH APIでA / AAAA両方を確認し、回答中に非公開IPが1件でもあれば拒否。内部向けCNAME、DNS失敗・空回答・不正応答も拒否。
- native fetchは毎回`redirect:"manual"`。全Locationを再検証し、移動先のDNSも再確認。回数・ループを制限。
- WorkerにNiaoの認証情報やストレージbindingを追加しない。外部サイトへAuthorization / Cookieを送らず、取得URL・本文・例外の生メッセージを標準ログに出さない。

**DNS検査と実際のHTTP接続は別の名前解決です。検査済みIPへの接続固定は行えず、DNS rebinding / TOCTOUを完全には防げません。** 汎用的なIP固定に`cf.resolveOverride`は使えません（同一zoneなどの制約があります）。Service Bindingを完全なネットワークサンドボックスとも扱いません。ローカル開発のMiniflareが持つ接続範囲も本番とは異なるため、開発サーバーを未認証の外部利用者へ公開しないでください。完全な保証が必要なら、URLの許可リストまたは接続IPを固定できる専用egressを別途設ける必要があります。

[Cloudflare DoH JSON API](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)、[resolveOverrideの制約](https://developers.cloudflare.com/workers/runtime-apis/request/#requestinitcfproperties)。

## 開発・テスト・デプロイ

```sh
npm ci
npm run typecheck --workspaces
npm run test -w apps/worker
npm run build:tools
npm run build:worker
```

テストは外部HTTP/DNSのみfixtureへ差し替えます。実際のworkerd、コンパイル済みtools-miscのService Binding RPC、Readability / LinkeDOM / Turndown、既存のLLMループを通します。自動テストは実サイトや本番トークンに依存しません。今回のWorkerスイートは既存分を含む197件が成功し、全workspaceの型チェック・AgentとTools Workerのdry-runビルドも成功しています。Ruby・Past Logs・天気・kani・Thinkingなどの既存テストも継続します。

ローカルの`npm run dev`は既存のmulti-worker構成でtools-miscを起動します。Niaoへ接続して、公開URLの要約を依頼してください。別途ブラウザを起動する仕組みはありません。

利用者が明示的にデプロイする場合、RPC呼び出し先を先に更新します。

```sh
npm run deploy -w apps/tools-misc
npm run deploy -w apps/worker
```

同期版は追加secret、DB、Browser Run、Dynamic Workers、Paid専用bindingを使いません。非同期版のBrowser bindingは[別途設定](async-fetch.md)します。アプリのリビルドも不要です。この実装作業ではデプロイしていません。

## Workers Freeでの計測

FreeのCPU予算はHTTPリクエストあたり10msで、ネットワーク待機時間はCPU時間とは別です。既定のredirect数ならDNS 2回＋取得1回を最大4段、計12 subrequestsです。[Cloudflareの制限とCPU計測](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)

再現可能なローカルworkerdの計測:

```sh
npm run build:tools
node apps/tools-misc/scripts/bench-web-fetch.mjs /tmp/niao-web-fetch-profiles
```

追加のローカルHTMLを測る場合は第2引数にファイルを指定できます。既定値を超える入力の診断には`NIAO_WEB_BENCH_EXPANDED_LIMITS=1`を明示した場合だけ128 KiB・1,500要素に引き上げ、レポートにも記録します。

Node.js 22.18以降が必要です。fixtureだけを用い、実際のService Binding経由で各ページを11回取得し、Tools WorkerのV8 CPU profileを保存します。100μsサンプリングのうちidle/root/programを除いた時間の推定です。スケジューラの待機やprofiler自体の誤差があり、**Cloudflare課金CPU時間やFreeプラン上での成功保証ではありません**。実サイトの通信時間もこの計測には含みません。

Apple Siliconのローカルworkerdでの一例:

| fixture | HTML bytes | 初回の推定CPU ms | 2回目以降の中央値 / 最大 ms |
|---|---:|---:|---:|
| 短い日本語メモ | 82 | 18.83 | 3.36 / 3.67 |
| 日本語記事＋コード・表 | 2,043 | 5.95 | 3.83 / 7.60 |
| 英語記事＋コード・表 | 2,155 | 3.55 | 2.92 / 3.59 |
| 日本語80段落 | 21,423 | 5.78 | 5.25 / 5.95 |

短いメモがisolateの最初のRPCです。他の行の初回は、そのページの初回であり、isolateのコールド起動ではありません。最初のRPCは17〜19ms前後の推定値になり、`getReader`などの組み込み処理・GCのサンプルもprofileに含まれました。抽出関数以下の推定最大はこの測定で約5.6msでしたが、**初回や複雑なページを常に10ms以内に収めたとは主張しません**。本番のCPUメトリクスは未計測です。ログの`durationMs`は壁時計時間で、CPU時間として解釈しないでください。

ローカルの実HTTP通信でもHTML、kaniのMarkdown、GitHubのplain textを取得できることを確認しました。上限を128 KiB・1,500要素へ明示的に引き上げるとRuby公式のRuby 4.0.0リリース記事（HTML約94 KiB）も抽出でき、12,000文字で`truncated:true`になりました。ただし推定CPUの中央値は約40msで、Free向きではありません。これを踏まえ、既定値を32 KiB・300要素へ抑えています。大きな記事をFreeで広く読めるとは主張しません。任意サイトへの一般公開クローラーとしての負荷・悪意あるHTML全般のCPU上限は保証しません。Freeで上限エラーが出る場合はダウンロード・DOM上限を下げ、対象を小さなページに限定してください。実行時に有料サービスへフォールバックする動作はありません。

## 抽出の限界と将来の拡張

通常のHTTP取得だけなので、JavaScriptで後から描画される本文、ログインが必要なサイト、Bot対策に遮断されるサイトは取得できない場合があります。ページのCSSを完全には評価せず、Readabilityが本文の一部を落とすこともあります。32 KiBを超える本文や300要素を超えるHTMLは既定で拒否します。

非同期`web_fetch_async`は専用の`webFetchAsync()` RPCでBrowser Run `/markdown`へ変換を委譲します。ネットワーク検証と出力制限を再利用し、同じ`WebFetchResult`へ正規化しています。同期`web_fetch`の中でBrowser Runへ自動フォールバックすることはありません。[構成・制限・デプロイ手順](async-fetch.md)。
