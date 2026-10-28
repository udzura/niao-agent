# Code Mode: 固定PicoRuby Runner

Code ModeをWorker Loaderから、固定配置の`niao-ruby-runner`とService Binding RPCへ移行しました。Dynamic Workersに由来する有料プランの依存を除くためです。生成するのはRubyソースだけで、WorkerのJSとWasmは事前ビルド・配置します。Pondroや別のAgentランタイムは導入しません。

## 構成・互換性

```text
Niao.app → NiaoAgent → ruby_eval → RUBY_RUNNER.execute({code})
                                       ↓
                            niao-ruby-runner / PicoRuby Wasm
                                       ↓
                           結果 → 同じモデル → 回答
```

既存の正式なツール名は`ruby_eval`です。設計案の`execute_ruby`には改名せず、スキーマとモデルへ返す`{ok,value?,error?,instructions,stdout}`を維持しています。Agentの会話履歴、モデル選択、WebSocket、認証、macOS UIに移行のための変更は不要です。

`apps/ruby-runner/src/index.ts`のdefault `WorkerEntrypoint`が`execute({code})`を提供します。RunnerのRPC結果には、互換フィールドに加えて`stderr`、`exitCode`、`timings`があります。成功時は`stderr:""`、`exitCode:0`、失敗時は安全なエラーコードと`exitCode:1`を返します。例外本文やコンパイラ診断にはソースが含まれることがあるため、そのまま公開・記録しません。アダプタは追加メタデータを除いてモデルへ返します。

`niao_eval`、`niao_reason`、`niao_count`、`niao_result_len`は既存のNiao側C拡張の実エクスポートです。`niao_eval`はPicoRubyのコンパイラでソースをコンパイルし、mruby VMで実行します。JavaScriptのevalやnew Functionは使用しません。計測用のフェーズ通知だけをC拡張へ追加しました。

## Rubyの入出力

引数例: `{"code":"(1..100).inject(0) { |s,n| s+n*n }"}`。最後の式は文字列・数値・真偽値・nilに限定し、値を文字列として`value`へ格納します。配列などは`join`等で整形してください。stdin/JSON入力専用APIと任意オブジェクトの自動シリアライズはありません。

`puts` / `print` / `p`は上限付き診断出力です。各引数の後に改行するため、CRubyの厳密な出力互換ではありません。`stdout`はモデルへ返しますがホストのconsoleへ流しません。途中まで出力して例外になった場合も、回収済みの出力は返します。

## 実行制限と安全性の境界

- ソース8KiB（UTF-8）、VM命令20万回、診断出力4KiB、結果8KiB。
- 命令超過はWasm trapで終了。Rubyの`rescue`や`ensure`では延長できません。
- Wasmの線形メモリは固定32MiB、Cスタック1MiB、コンパイラの構文ネスト上限64。
- 不変のコンパイル済みWasmモジュールを共有し、毎回新しいWasmインスタンスとVMを生成。グローバル変数やクラス定義を引き継ぎません。
- 終了時はホスト参照を解放し、Wasmメモリ全体をGCで回収。trap後にRubyのcleanup/ensureを実行せず、VMを再利用しません。即時のメモリ回収は保証しません。
- 同一Runner isolateの実行中は次の要求を`runner_busy`で拒否します。これはisolate単位の制御で、アカウント全体の同時実行制限ではありません。
- Runnerはストレージ・AI等のbindings、vars、secretsを持ちません。Rubyへファイル、ネットワーク、ENV、外部プロセス、動的require/load/evalを公開しません。
- `workers_dev:false` / `preview_urls:false`、HTTP fetchは404。実行APIは同一アカウント内のService Binding RPCだけです。Runnerにルートやカスタムドメインを追加しないでください。
- モデル呼び出し最大4回、ツール実行最大3回、既存のAgent応答期限90秒を維持。失敗時にDynamic WorkersやDO内実行へフォールバックしません。

**Service BindingはDynamic Workerと同等のセキュリティ境界ではありません。** 標準Workerにはホスト側のfetch機能があります。Rubyが通信できないのは、それをWasm importsやRuby APIへ公開していないためで、以前の`globalOutbound:null`の強制遮断はありません。

**任意のC処理を中断するアプリ側のハードタイムアウトはありません。** VM命令数はコンパイラやCメソッド内のCPU量を測れず、Promise/AbortSignalは同期Wasmを強制停止しません。Service Bindingの両Workerは通常同じスレッドで実行されるため、親Agentのタイマーも強制停止装置にはなりません。以前のDynamic Worker用100ms CPU設定は削除しています。最終的にはプラットフォーム側CPU制限に従い、制限超過はRPC失敗になることがあります。

32MiBの上限はWasm線形メモリの上限です。JS、コンパイル済みコード、GC待ちメモリを含むWorker全体のハード上限をアプリが制御するものではありません。VM・コンパイラ・Wasm・ホスト実装の不具合まで防げる完全なsandboxとは主張しません。

## ローカル開発と検証

生成済みJS/Wasmは`apps/ruby-runner/src/generated/`に同梱しています。通常の開発にはRuby/Emscripten不要です。

```sh
npm ci
npm run dev
```

内部で`wrangler dev -c wrangler.jsonc -c ../ruby-runner/wrangler.jsonc`を実行します。Agentが`127.0.0.1:8787`で公開され、Runnerは補助WorkerとしてService Binding経由で動きます。認証設定とmacOSアプリのURLは従来どおりです。Runnerには`.dev.vars`を作らず、Agentのシークレットをコピーしないでください。

```sh
npm test              # Runnerをdry-runビルド後、実workerd RPC/Wasmで検証。AIはfixture
npm run typecheck     # 両Worker
npm run build:runner  # Runner dry-run
npm run build:worker  # Agent dry-run
npm run bench:ruby    # ローカルNode/V8 CPU計測。AI料金なし
```

Wranglerの実multi-worker接続を、AIを呼ばず確認する場合:

```sh
npx wrangler dev -c tools/ruby-sandbox/smoke/wrangler.jsonc -c apps/ruby-runner/wrangler.jsonc --ip 127.0.0.1 --port 8790
# 別ターミナル
curl --fail http://127.0.0.1:8790
# {"ok":true,"value":"2","instructions":3,"stdout":""}
```

このsmoke Workerはローカル検証専用で、デプロイしません。チャットでの確認は「Rubyで1から100までの二乗の和を計算して」と送信します。この場合のみ通常のWorkers AI使用量が発生します。

## Wasm再ビルド

独自部分は`tools/ruby-sandbox/`にあります。上流のソースを変更せず、Niaoの`build/picoruby/`へコピーしてビルドします。Ruby/rake、Python3、rsync、Emscripten（検証6.0.13）が必要です。

```sh
# sources.jsonで指定したPicoRubyのコミットをcheckoutする
# git submodule update --init --recursive mrbgems/picoruby-mruby/lib/mruby mrbgems/mruby-compiler mrbgems/mruby-bin-mrbc
PICORUBY_ROOT=/path/to/picoruby npm run build:ruby
npm test
```

依存のコミットは`sources.json`で照合します。依存変更時は`build/picoruby/`の古い成果物を除去して再ビルドしてください。ライセンスは`tools/ruby-sandbox/licenses/`にあります。

## デプロイ順序

**この移行作業ではデプロイしていません。以下は利用者が実行する手順です。** 同じCloudflareアカウントへRunnerを先に配置します。

```sh
npm run deploy -w @niao/ruby-runner
npm run deploy -w @niao/worker
```

Agentの`RUBY_RUNNER`が`niao-ruby-runner`のdefault entrypointを参照します。Runner用の新しい秘密情報は不要です。名前やWrangler環境を変更した場合はService Bindingの`service`も一致させてください。Code Modeのためだけに有料のWorker Loaderを契約する必要はありません。ただし、本番FreeのCPU予算内での安定性は下記のとおり未確認です。

## Freeプラン・性能

公式のWorkers FreeのCPU制限はHTTP requestあたり10msです。プラットフォームの課金・制限と、ローカル経過時間を同一視しません。Service BindingでWorkerを分けても、計算資源が無料で無制限に増えるわけではありません。Niao全体のAI/DO等の利用上限も別途適用されます。

`npm run bench:ruby`はNodeの`threadCpuUsage`で合計CPU時間を測り、Wasm初期化・VM生成・コンパイル・評価・JSON整形を`performance.now()`で分けて計測します。実Runner RPCの`timings`にも段階ごとの経過時間を返しますが、Workersの時計は同期実行中に進まない場合があり、ゼロ値はCPUコストゼロを意味しません。RPCのシリアライズ時間はランタイム内部であり、JSON整形の計測とは異なります。

Apple Silicon / Node v26.12.1でのローカル測定（各30回、初回を別計測、単位ms）:

| 処理 | CPU中央値 | CPU p95 | CPU最大 |
| --- | ---: | ---: | ---: |
| `1 + 1` | 0.366 | 1.117 | 1.441 |
| `puts` | 0.407 | 2.459 | 3.165 |
| 100項の二乗和 | 0.397 | 1.639 | 1.899 |
| 1000項の和 | 0.889 | 1.387 | 1.504 |
| 無限ループ→20万命令で停止 | 2.791 | 4.196 | 4.545 |

モジュールロードのCPUは4.822ms、最初の`1 + 1`のCPUは9.107ms（別の測定では10.018ms）でした。初回起動は10ms近く、上記の中央値だけでFree動作を保証できません。生成Wasm/JSは約0.31MiB gzipでした。生の計測結果は[保存データ](benchmarks/ruby-static-local.json)を参照してください。

**現時点の結論: 有料専用機能への依存は撤去済み。軽量計算はローカルで成立するが、本番Freeのcold/warm呼び出し・CPU制限内動作は未確認。** デプロイ許可がないため、この受け入れ条件は未達です。Freeアカウントへの配置後に同じ小さな入力でcold/warmのCPUメトリクスと制限エラーを確認する必要があります。ローカルworkerdは本番のCPU制限を再現しません。

初回コストや複雑なコードが制限を超える場合は、ソース/処理量を絞る、VMとコンパイラのビルドを軽量化する、必要な計算だけ固定ツールとして実装する、ユーザーのMac上で実行する、という選択肢があります。自動的な有料実行への切り替えは行いません。

公式資料: [Service Binding RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)、[Service Bindingの実行特性](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)、[WebAssembly](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)、[multi-worker開発](https://developers.cloudflare.com/workers/local-development/multi-workers/)、[Workers制限](https://developers.cloudflare.com/workers/platform/limits/)。
