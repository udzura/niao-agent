# Past Logs

過去の記事・日記を保存し、Niaoから検索する独立Workerです。会話から知識を蒸留するPersonal Knowledge Baseとは別です。自動巡回、埋め込み、Vectorizeは使用しません。

```text
インポーター ── REST + admin token ──┐
                                   ├── DocumentService ── D1 + FTS5
NiaoAgent ── MCP/HTTP + read token ──┘
  └─ Workers AIの既存ツールループ（ruby_evalと併用）
```

## ローカル起動

リポジトリルートで`npm ci`を実行後、ターミナルAで:

```sh
cp apps/past-logs/.dev.vars.example apps/past-logs/.dev.vars
chmod 600 apps/past-logs/.dev.vars
openssl rand -hex 32
openssl rand -hex 32
```

生成した**異なる2つ**の値を`.dev.vars`の`PAST_LOGS_ADMIN_TOKEN`と`PAST_LOGS_READ_TOKEN`に設定します。このファイルはGitの対象外です。

```sh
npm run db:migrate -w apps/past-logs
npm run dev:past-logs
```

`http://127.0.0.1:8788`で起動します。ローカルD1は`apps/past-logs/.wrangler/state`に永続化します。サンプルDB IDのままでもローカル開発は可能です。

ターミナルBで既存の`apps/worker/.dev.vars`に次の2項目を追加します。NIAO_TOKENなどの既存設定は保持してください。

```dotenv
PAST_LOGS_MCP_URL=http://127.0.0.1:8788/mcp
PAST_LOGS_MCP_TOKEN=<Past LogsのPAST_LOGS_READ_TOKENと同じ値>
```

```sh
npm run dev
```

NiaoAgentとRuby Runnerが起動します。Past LogsにはURL経由のStreamable HTTPで接続します。Service BindingをMCPの代用にはしません。macOSアプリの接続先は従来のNiaoAgent（通常`http://127.0.0.1:8787`）です。この機能のためのアプリ再ビルドは不要です。

## サンプル取り込み・疎通

サンプル3件は架空の記事・日記で、URLも`example.com`です。以下ではzshの非表示入力で、設定ファイルと同じトークンを入力します。

```sh
read -rs 'PAST_LOGS_ADMIN_TOKEN?Past Logs admin token: '; echo
export PAST_LOGS_ADMIN_TOKEN
export PAST_LOGS_URL=http://127.0.0.1:8788
npm run import:sample -w apps/past-logs

read -rs 'PAST_LOGS_READ_TOKEN?Past Logs read token: '; echo
export PAST_LOGS_READ_TOKEN
npm run test:dev -w apps/past-logs
```

再取り込みも同じ3文書を更新します。疎通スクリプトは公式MCPクライアントでツール発見→「Cloudflare 日本語」検索→本文取得を実行します。Niaoには「昔のCloudflareと日本語検索の記事を探して、出典を教えて」と話しかけて確認できます。ツールを呼ぶかどうかはモデルが判断します。

## REST契約

管理APIはすべて`Authorization: Bearer <PAST_LOGS_ADMIN_TOKEN>`が必要です。MCP用read tokenではGETも許可されません。MCPでもadmin tokenは使用できません。秘密値は各32文字以上、同じ値の設定は503で拒否します。

| メソッド | パス | 結果 |
| --- | --- | --- |
| POST | `/api/documents` | 作成・上書きとも200、`{"document": ...}` |
| GET | `/api/documents/:id` | 200、完全な文書JSON |
| PUT | `/api/documents/:id` | 200、指定フィールドのみ更新 |
| DELETE | `/api/documents/:id` | 200、`{"id": ..., "deleted": true}` |
| GET | `/health` | 認証不要。サービス名とokのみ、DB内容は返さない |

登録例（上の非表示入力で環境変数を設定後）:

```sh
curl --fail-with-body --silent --show-error \
  -X POST "$PAST_LOGS_URL/api/documents" \
  -H "Authorization: Bearer $PAST_LOGS_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "source": "manual",
  "source_id": "notes/d1-japanese-v1",
  "url": "https://example.com/notes/d1-japanese",
  "title": "D1と日本語検索",
  "body": "Cloudflare Workersで日本語全文検索を作った技術メモ。",
  "created_at": "2024-01-01T12:00:00+09:00",
  "updated_at": null,
  "metadata": {"tags": ["D1", "検索"]}
}
JSON
```

- 必須: source（cosense/hatena/manual）、source_id、HTTP(S)のurl、title、body。
- IDは`SHA-256([source, source_id])`から生成します。同じ出典内IDへのPOSTはupsertになり、別出典では同じsource_idを使えます。POSTでidは指定できません。
- POSTは文書全体のupsertです。省略した日時・metadataはnullになります。部分更新はPUTを使用します。PUTでid、source、source_id、indexed_atは変更できません。
- created_at/updated_atはタイムゾーン付きISO 8601かnullです。元の公開・編集日時を指定し、不明ならnull。UTC ISOへ正規化します。indexed_atはサーバーの取り込み日時です。
- 本文128 KiB（UTF-8）、タイトル1024 UTF-16コード単位、source_id 1024、URL 2048、metadata 16 KiB、JSONリクエスト全体256 KiBが上限です。正規化による膨張を含め、生成する検索索引も各1 MBで制限します。
- 400: 検証/JSONエラー（本文上限を含む）。401: 認証失敗。404: 文書なし。405: 未対応メソッド。413: リクエスト/索引が過大。415: JSON以外。503: 認証未設定。予期しないDBエラーは内容を伏せて500です。
- SQLプレースホルダーを使用し、文書更新とFTS同期はトリガーで同一トランザクションに収めます。Content-Lengthだけでなく、読み込み中にもサイズ検証します。

将来のCosenseインポーターはプロジェクトと不変のページID、Hatenaはブログと不変のエントリーIDをsource_idに含めてください。URLやタイトルだけをIDにすると改名時に重複するため、不変IDが得られない出典ではインポーター側で対応表を保持します。canonical URL、元日時、本文を供給し、HTMLはインポーター側でプレーンテキスト/Markdownに変換します。metadataにはタグなどを格納できます。APIは1リクエスト1文書で、バッチ処理は同じPOSTを逐次呼べます。

## 日本語検索の選択

[D1はFTS5をサポート](https://developers.cloudflare.com/d1/sql-api/sql-statements/)します。[SQLiteの標準unicode61は日本語の形態素解析を行わず、trigramは3文字未満の部分文字列検索に制約](https://sqlite.org/fts5.html#tokenizers)があります。「検索」「日記」の2文字語を扱うため、アプリで索引語を生成してD1標準のunicode61 FTS5へ渡します。

- NFKC＋小文字化し、漢字・ひらがな・カタカナの連続部分を文字bigramにします。単一文字検索用にはunigramも付加します。
- 英語等は単語単位です。記号で区切り、日本語/英語の境界も分けます。128文字より長い単語は索引化しません。
- 索引語はASCIIのコードポイント列です。クエリも同じ変換を使い、bigramを連続フレーズ、複数語をANDで検索します。ユーザーのFTS演算子は実行しません。
- BM25で本文とタイトルを検索し、タイトルに6倍の重みを設定します。順位が同じならID順です。relevanceは`-bm25`で、大きいほど関連度が高い参考値です。
- 作成・更新・削除時にもSQLトリガーが索引を同期します。原文は正規化せず保持し、抜粋は原文から最大240 Unicode文字を返します。

これは決定的なキーワード検索です。同義語、活用、意味検索、英語stemming、英語部分文字列、typo補正、形態素解析はありません。日本語クエリ内は連続一致が必要なので、「日本語検索」と「日本語の検索」は別です。両方を探す場合は「日本語 検索」のように分けます。最大16語、query最大200 UTF-16コード単位です。ランキングと抜粋は将来調整できます。

ローカルD1でもunicode61/trigramの両方を作成して確認しました。未分割の「日本語検索」に対する2文字のMATCH「検索」はどちらも0件となり、採用したアプリ側bigram索引ではヒットします。

## MCPとNiaoの境界

`agents@0.31.0`のcreateMcpHandler()とMCP SDK v2 `@modelcontextprotocol/server@2.3.1`を使用し、リクエストごとにMcpServerを生成します。[現行のstateless Streamable HTTP方式](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)であり、Past LogsにDurable ObjectやMcpAgentはありません。

/mcpはread tokenで認証後、次の2ツールだけを公開します。

| ツール | 入力 | 出力 |
| --- | --- | --- |
| search_past_logs | query、limit（既定5、1–20）、任意source | ID、題名、source、元URL、公開日時、抜粋、relevance |
| get_past_log | id、offset（既定0）、limit（既定4000、最大8000） | 題名、元URL/出典、公開/編集日時、本文ページ、total_chars、next_offset |

ページのoffset/limitはUnicodeコードポイント単位です。next_offset:nullで終了します。存在しない文書はisError＋not_foundを返します。RESTとMCPは同じDocumentServiceを使い、MCPは書き込みメソッドを登録しません。readOnlyHintは説明情報であり、実際の制御はルート認証と公開ツールの制限です。CORSを認証の代用にはしません。

statelessサーバーのGET /mcpは405です。POST経由のツール呼び出しは動作し、SDKが接続時にGETを試す場合も正常に継続します。

Niaoは[Agent内蔵MCPクライアント](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/)で接続・発見します。getAITools()から得るスキーマをWorkers AI形式へ変換し、SDKのcallTool()で実行します（現行getAITools().executeがAbortSignalを引き渡さないため）。独自のJSON-RPCクライアントや別のagent loopはありません。

SDKの名前空間付きツール名はtool_pastlogs_search_past_logsとtool_pastlogs_get_past_logです。この2つだけを許可し、別ツールが追加されても自動では取り込みません。既存の1ターン最大3ツール実行・4推論という共通上限を維持します。

接続はターンごとに再登録・クリーンアップします。read tokenはfetch直前に付与し、SDKの接続設定SQLiteには保存しません。HTTPS必須（loopback開発のみHTTP可）、URLに認証情報・queryを含めず、リダイレクトも拒否します。接続準備・HTTPは5秒、ツール呼び出しは8秒の制限を設け、失敗時は通常チャットへ進むか安全なツールエラーを返します。チャット全体の90秒期限も維持します。MCP未設定なら従来どおりRubyとチャットだけで動きます。

記事本文・題名・metadataは信頼しない参考データとしてツール結果に入れ、system/user命令として挿入しません。モデルにはその扱いと出典URLの引用を指示します。プロンプトインジェクションを完全に防ぐ保証ではありません。本文、検索語、認証値、生の例外はログ出力しません。

## デプロイ（手動）

この変更では本番の作成・移行・デプロイを実行していません。実施する際はリポジトリルートから:

```sh
cd apps/past-logs
npx wrangler d1 create niao-past-logs
```

返されたdatabase_idでwrangler.jsoncのサンプルUUIDを置き換えます。DB IDは認証情報ではありません。Wranglerのアカウントが意図したものか確認してから:

```sh
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put PAST_LOGS_ADMIN_TOKEN
npx wrangler secret put PAST_LOGS_READ_TOKEN
npm run deploy
```

Past LogsのHTTPS URLを使い、apps/worker/wrangler.jsoncへ非秘密設定を追加します（ローカルURLは.dev.varsで上書きされます）。

```json
"vars": {
  "PAST_LOGS_MCP_URL": "https://niao-past-logs.<your-subdomain>.workers.dev/mcp"
}
```

続いて:

```sh
cd ../worker
npx wrangler secret put PAST_LOGS_MCP_TOKEN
npm run deploy
```

PAST_LOGS_MCP_TOKENにはPast LogsのPAST_LOGS_READ_TOKENと同じ値を入力します。admin tokenはNiaoAgentに設定しません。順序はD1作成/移行→Past Logs→NiaoAgentです。今回Ruby Runnerの再デプロイは不要です。本番へサンプルを入れる場合はPAST_LOGS_URLを本番URLに明示します。

## 検証・Freeプランの範囲

```sh
npm test
npm run typecheck
npm run build:past-logs
npm run build:worker
```

テストはローカルD1/workerdを使います。Agent統合テストも実MCPクライアント→実Past Logs Worker→D1を通り、既存Ruby Runner RPCまで検証します。推論部分だけを明示的な決定的テストモデルにしています。test:devは独立起動したWorkerの実TCP/HTTPを使用します。

2026-10-29の検証: Past Logs 10件、Niao 96件（既存93件＋MCP統合3件）、型チェック、Worker dry-run buildが成功。サンプル3件のHTTP取り込みとMCP検索・取得も確認しました。Niaoの推論を含む本番疎通は未実施です。

別プロセスのPast Logsを同じローカルD1で再起動後、再取り込みなしでMCP検索・取得が成功しました。Agent内蔵MCPクライアントから実際のloopback URLへ接続する追加プローブも成功しています。今回のgzipバンドルはPast Logs約216 KiB、NiaoAgent約433 KiBです。macOSとRuby Runnerのソースは変更していません。

新サービスはD1と固定Workerのみで構成し、Freeプランで利用可能なAPIを使います。これだけでFreeのCPU/日次クォータ内の本番稼働を保証しません。[WorkersのCPU/サイズ制限](https://developers.cloudflare.com/workers/platform/limits/)と[D1のクエリ・容量制限](https://developers.cloudflare.com/d1/platform/limits/)は別に適用されます。ngram索引は保存量・書き込み量を増やし、単一文字検索・大きい記事の取り込みほど負荷が増えます。大量取り込みは逐次処理し、本番でCPU・D1 rows_read/rows_written・容量を確認してください。

将来の改善候補はバッチ取り込み、更新差分の検出、形態素解析、ランキング改善です。自動クロールや会話の知識抽出は実装しません。
