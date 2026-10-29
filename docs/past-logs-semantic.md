# Past Logsの意味検索

Past Logsは、原文をD1に保存し、検索方法を2つのMCPツールに分けます。Niaoが必要な検索を選択し、取得した記事を引用して回答します。Past Logs自身で追加の回答生成LLMを呼ぶことはありません。

| MCPツール | 用途 | 検索方式 |
| --- | --- | --- |
| `search_past_logs` | 技術用語、プロジェクト名、実際の言及 | 既存D1/FTS5のngram・単語検索。Embedding不要 |
| `search_past_logs_semantic` | 曖昧な記憶、言い換え、概念、関連する話題 | Workers AI Embedding＋Vectorize cosine検索 |
| `get_past_log` | どちらの検索で見つけた記事も読む | 共通のD1原文・ページ分割 |

既存のキーワードツール名は互換性のため維持しています。完全なバイト列一致を保証するexact検索ではなく、これまでどおり正規化後のキーワード検索です。自動ハイブリッド検索やrerankingは追加していません。Niaoは両方を比較してから記事を読むこともできます。既存の1ターン最大3ツール呼び出しという上限は共通です。

## 保存と索引

```text
REST import/update/delete
  └─ D1 transaction: documents + FTS5 + semantic_jobs
       └─ SemanticIndex: chunk → Workers AI → Vectorize
                              └─ D1へ進捗・mutation IDを記録
MCP semantic query → query Embedding → Vectorize → 現在のD1 revisionと照合 → 記事候補
```

モデルはCloudflare公式の[`@cf/qwen/qwen3-embedding-0.6b`](https://developers.cloudflare.com/workers-ai/models/qwen3-embedding-0.6b/)、1024次元、cosineです。[モデルの公式説明](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)にある多言語検索に対応したモデルを使用します。文書は`documents`、検索は`queries`＋英語の検索指示というモデルAPIを使い分けます。

本文を1200 Unicodeコードポイント、重なり150文字で分割し、各チャンクの先頭に最大200文字の題名を付けます。Vectorizeにはベクトル、source、D1 document ID、revisionだけを保存します。原文・URL・日時はD1から取得します。公開用の`doc_`＋SHA-256はVectorizeのID上限64バイトを超えるため、ベクトルIDは別途`SHA-256(index_version, document_id, revision, chunk_index)`の64桁hexです。

チャンク処理方針とモデルは`embeddings.ts`へ集約し、namespaceを`qwen3-06b-1024-c1200-o150-v1`に固定しています。モデルや分割方針を変える際はnamespaceも変更し、再索引してください。索引の次元・距離関数は自動変換しません。

## D1とVectorizeの整合性

D1とVectorizeを跨ぐトランザクションはありません。D1を原本とし、次の方式で回復可能にしています。

- マイグレーション0002が、既存記事を含めて`semantic_jobs`に処理対象を記録します。新規・更新・削除時にもSQLトリガーで同じD1トランザクションにジョブを書き込みます。
- 本文・タイトルが変わったときだけrevisionを更新します。同一内容の再取り込みやURL・日時・metadataだけの変更は再Embeddingしません。
- RESTのPOST/PUT/DELETEはD1更新後、意味索引への登録・削除をその場で試みます。HTTP 200はD1保存の成功です。追加の`semantic_index`フィールドで`pending`か`submitted`、進捗、最後の安全なエラーコードを確認してください。
- **submittedはVectorizeへの受付完了**です。[Vectorizeの更新・削除は非同期](https://developers.cloudflare.com/vectorize/reference/client-api/)なので、検索可能になるまで遅延があります。read-after-write整合性を意味しません。
- 文書単位の120秒のリースで同時処理を抑え、実処理の待ち時間は25秒で制限します。8チャンク単位、1回最大4バッチ（32チャンク）を処理し、進捗をD1へ保存します。長い記事は次の呼び出しで続きから処理します。
- ベクトルIDは外部書き込みの前にD1へ記録します。不確定な書き込みの再試行でも同じIDをupsertします。中断したリースは期限後に再取得できます。
- 削除・古いrevisionのベクトルも削除します。ただし検索結果は必ずD1の存在と現在revisionで照合するため、古いベクトルが残っていても古い本文・削除済み文書を返しません。
- 過去のチャンクID・削除ジョブは再照合の記録としてD1に残します。本文やEmbedding値は保持しません。異常終了や外部RPCの遅延で削除後に古いupsertが届いた場合、`--force`で再度削除できます。物理的な孤立ベクトルが常に即時ゼロになる保証はありません。

Providerの失敗は`embedding_unavailable`、不正なベクトルは`invalid_embedding`、Vectorizeの失敗は`vector_*_unavailable`などのコードで報告します。生の例外、本文、検索文、認証値はログへ出しません。意味検索の失敗をキーワード検索の結果や架空のベクトルで置き換えません。Niaoは別ツールとしてキーワード検索を選び直せます。

## ローカル開発

[Cloudflareの対応表](https://developers.cloudflare.com/workers/local-development/bindings-per-env/)ではWorkers AIとVectorizeのローカルシミュレーションは未対応です。実際の意味検索を試す場合、WorkerとD1はローカル、AIとVectorizeはremote bindingにします。Embedding・Vectorizeの利用量はアカウントに計上されます。

開発用インデックスは本番と分けます。以下は**手動のリソース作成手順**です。この変更の実装中には実行していません。

```sh
cd apps/past-logs
npx wrangler login
npx wrangler vectorize create niao-past-logs-dev --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index niao-past-logs-dev --propertyName=source --type=string
npm run db:migrate
npm run dev
```

metadata indexはsourceフィルターに必要で、最初の取り込み前に作成します。`npm run dev`は`--env development`を使用し、`niao-past-logs-dev`へ接続します。ローカルD1には本番DBのID・remote設定を使用しません。認証値は従来の`.dev.vars`へ別々のadmin/readトークンを設定します（既存の[設定手順](past-logs.md)参照）。

Cloudflare接続なしでREST・キーワード検索だけ動かす場合:

```sh
npm run dev:offline
```

こちらは`wrangler.offline.jsonc`の実ローカルD1を使います。意味検索は`semantic_not_configured`を返し、索引ジョブはD1にpendingとして残ります。あとで実bindingを設定して再索引できます。テスト用fixtureをこの開発サーバーへ組み込むことはありません。

## 既存記事の索引化と失敗の再試行

zshの非表示入力で管理トークンを設定後:

```sh
read -rs 'PAST_LOGS_ADMIN_TOKEN?Past Logs admin token: '; echo
export PAST_LOGS_ADMIN_TOKEN
export PAST_LOGS_URL=http://127.0.0.1:8788
npm run reindex -w apps/past-logs
```

1リクエスト1文書ずつ、永続ジョブをページ送りし、長い記事は複数回の呼び出しで進めます。失敗や有効なリースを検出したら停止します。原因を修正し、必要ならリース期限を待って再実行してください。標準では最大1000リクエストで停止し、`PAST_LOGS_INDEX_MAX_REQUESTS`（1–10000）で上限を調整できます。

インデックスを外部で再作成した場合や、古いベクトルの再削除も行う場合:

```sh
npm run reindex -w apps/past-logs -- --force
```

forceは既にsubmittedの記事も再Embeddingするため、その分の利用量が発生します。自動Cron、Queues、追加Durable Objectはありません。取り込み時の試行後に残ったpendingは、この管理コマンドで回復します。

RESTの管理エンドポイント（両方ともadmin tokenが必要）:

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $PAST_LOGS_ADMIN_TOKEN" \
  "$PAST_LOGS_URL/api/semantic-index"

curl --fail-with-body --silent --show-error \
  -X POST -H "Authorization: Bearer $PAST_LOGS_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"limit":1,"force":false}' \
  "$PAST_LOGS_URL/api/semantic-index/reindex"
```

状態APIはconfigured、モデル/次元、pending・failed数などを返します。totalには削除tombstoneも含みます。reindexの`after`は前ページの`next_after`、`has_more`で継続します。1周後もpendingが残れば、afterを省いて再開します。read tokenではこれらの管理APIを呼べず、MCPにも索引変更ツールは公開しません。

## 検索入力と出力

`search_past_logs_semantic`の入力:

```json
{"query":"昔、処理を中断して外部I/Oを待つ仕組みを考えていた話", "limit":5, "source":"cosense", "min_score":0.3}
```

queryは必須・最大2000 UTF-16コード単位、limitは既定5・最大20、sourceは任意、min_scoreは既定0・範囲−1〜1です。スコア閾値はモデル・コーパスによって適切な値が変わるため、クエリで調整できます。cosineスコアは確率ではありません。

上位50チャンクを取得し、D1の現在revisionと照合して文書単位で重複排除します。sourceはVectorizeのmetadata filterとD1の両方で確認します。同一文書が候補を多く占めると、返る文書数はlimitより少なくなることがあります。抜粋は対応チャンクの先頭付近から最大240文字で、ヒット位置の厳密なハイライトではありません。

結果は既存キーワード検索と同じID・題名・URL・公開日時・抜粋・relevanceに加え、search_method、chunk_start/chunk_endを返します。原文は`get_past_log`から取得します。索引が部分的・反映待ちの場合、空の結果が記事の不存在を意味するわけではありません。

## デプロイ

初回は既存のD1作成・トークン設定に加え、本番インデックスを作成します。既存D1のdatabase_idをmainのwrangler.jsoncに設定し、開発用設定にはコピーしないでください。

```sh
cd apps/past-logs
npx wrangler vectorize create niao-past-logs --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index niao-past-logs --propertyName=source --type=string
npx wrangler d1 migrations apply DB --remote --env=""
npm run deploy
```

既存のadmin/read secretは維持します。新しいCloudflare APIトークンをアプリ内へ設定する必要はありません。AIとVectorizeにはWorkerのbindingでアクセスします。続いてNiaoAgentを再デプロイし、新しいツールの許可リストを反映します。

```sh
npm run deploy -w @niao/worker
```

上の最後のコマンドはリポジトリルートから実行します。macOSアプリとRuby Runnerの再ビルド・再デプロイは不要です。PAST_LOGS_URLを本番HTTPS URLにして`npm run reindex -w apps/past-logs`を実行すると、既存D1記事を索引化できます。

## 検証と費用の範囲

```sh
npm test
npm run typecheck
npm run build:past-logs
npm run build:worker
```

ローカルD1/workerd上で移行・二重登録・再試行・中断/リース回復・部分進捗・同時更新・削除・再取り込み・source/score・MCP認証/入力検証を確認します。AI/Vectorizeは明示的なテストfixtureで、これは実モデルの検索品質や実Vectorizeの反映遅延の保証ではありません。

実bindingを設定してサンプルを取り込み、reindex完了・Vectorizeへの反映後に:

```sh
read -rs 'PAST_LOGS_READ_TOKEN?Past Logs read token: '; echo
export PAST_LOGS_READ_TOKEN
npm run test:dev -w apps/past-logs
npm run test:semantic:live -w apps/past-logs
```

実サービス用スクリプトは「実行の状態が残らない処理系」という日本語の問い合わせで、英語のRuby VMサンプルが候補に含まれ、原文取得できるかを検査します。検索品質は実モデル次第なので、失敗を架空のヒットで補いません。今回、実AI/Vectorizeのリソース作成・本番デプロイ・実モデル疎通は実行していません。

Embeddingは取り込みと意味検索の両方で消費します。Niaoのアカウント全体のGraphQL使用量には反映されますが、NiaoAgent内のローカル推論記録には加算しません。キーワード検索はEmbeddingを使いません。Structured logにはモデル、種類、件数、待ち時間と安全なエラーコードだけを記録します。

Freeで利用できるAPIを選び、1回の処理量を制限していますが、最大サイズの記事がFreeのCPU時間や日次クォータに必ず収まると保証しません。[Vectorizeの制限](https://developers.cloudflare.com/vectorize/platform/limits/)、[Workers AIの料金](https://developers.cloudflare.com/workers-ai/platform/pricing/)、D1の読み書き・保持する履歴IDの容量を確認してください。本番でのCPU・利用量・意味検索品質の評価は残っています。
