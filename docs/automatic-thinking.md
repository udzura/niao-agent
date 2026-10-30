# Thinkingの自動判定

チャットのメッセージ入力欄にあるThinkingメニューで「自動（控えめ／標準／多め）／常にON／常にOFF」を選びます。変更はその場でサーバーへ保存し、次の会話ターンから適用します。保存中は送信を無効にし、失敗時は再接続してサーバーの設定を確認します。設定画面の保存ボタンは不要です。モデルの変更は引き続き設定画面で行い、Thinkingの設定は保持します。

生成中にも変更できますが、実行中のターンには影響しません。設定は次回の起動・再接続後も復元します。既存のON/OFFはそれぞれ「常にON／常にOFF」、従来の既定ポリシーの自動は「自動（標準）」として表示します。新規設定の既定は「常にOFF」です。

現在thinkingを生成できるモデルはGemma 4です。GLMでは設定値を保持しますが、thinkingとjudgeの呼び出しは無効です。Gemmaへ戻すと保存値が適用されます。

## 判定と調整

自動では、ターン開始時に `@cf/cloudflare/clef-flash` を1回呼びます。入力は最新リクエストと直近の通常会話（最大5メッセージ、12,000 UTF-16コード単位）です。ユーザー入力を `state` に置き、信頼する判定指示を `questions.needs_thinking` に分離します。質問型は `noul`（Yesの確率）です。[Clef-flash API](https://developers.cloudflare.com/workers-ai/models/clef-flash/)

| 判定スコア | 既定の動作 |
| --- | --- |
| 0〜0.35（下限閾値を含む） | OFF |
| 0.35より大きく0.65より小さい | 曖昧としてON |
| 0.65〜1（上限閾値を含む） | ON |
| 不正な応答・通信失敗・3秒のタイムアウト | ON |

スコアはモデルによる判定で、thinkingによって回答が改善する実測確率ではありません。日本語の実際の依頼セットで調整してください。挨拶と設計比較のライブサンプルは確認しましたが、日本語全般の正解率や節約量は未評価です。

### 自動の3段階

| 入力欄の選択 | OFFにする上限スコア | ONにする下限スコア | 間の曖昧な範囲 |
| --- | --- | --- | --- |
| 自動（控えめ） | 0.65 | 0.85 | ON |
| 自動（標準） | 0.35 | 0.65 | ON |
| 自動（多め） | 0.15 | 0.45 | ON |

これはThinkingを使う**頻度**のプリセットで、推論の深さやトークン上限を変える設定ではありません。全プリセットで曖昧時はONなので、実際のON/OFFの境目はOFF側の閾値です。判定失敗時もすべてONです。各段階の検索・回答品質や節約量は未評価で、初期の調整値として扱います。

メニューは既存の `thinkingMode` と `thinkingPolicy` をまとめて更新するだけで、新たなjudge呼び出しやDB移行は追加しません。プリセット選択は閾値と `ambiguity:on` を設定し、既存の `timeoutMs` は保持します。常にON/OFFへ切り替えても自動用の方針は残します。APIで別の閾値や `ambiguity:off` を設定していた場合は「自動（カスタム）」と表示し、明示的にプリセットを選ぶまでその方針を維持します。

同じターンのRubyツール実行後にも開始時の判断を使います。生成中の設定変更は次のターンへ適用します。完了済み送信の再送ではjudgeも再実行しません。失敗したターンを再試行した場合は、現在の設定で新たに1回判定し、その使用量も記録します。親ターンの90秒期限には判定時間も含めます。タイムアウト時のプロバイダー中断はbest effortで、課金の取消を保証しません。

## 設定API

既存の認証付きモデル設定APIを使用します。アプリはモードと3段階のプリセットを変更でき、詳細な判定方針はAPIから調整できます。Thinkingだけを変更する場合は `modelId` を省略できます。

```sh
curl --fail-with-body -X PUT \
  -H "Authorization: Bearer $NIAO_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"thinkingMode":"auto","thinkingPolicy":{"offThreshold":0.35,"onThreshold":0.65,"ambiguity":"on","timeoutMs":3000}}' \
  "$NIAO_BACKEND_URL/agents/niao-agent/personal/settings"
```

- `thinkingMode`: `auto` / `on` / `off`。省略すると現在値を保持します。
- `modelId`: 省略すると現在のモデルを保持します。モデルだけの変更はモード・方針を保持します。少なくとも1つの設定項目が必要です。
- `thinkingPolicy.offThreshold` / `onThreshold`: `0 <= offThreshold < onThreshold <= 1`。境界値はそれぞれOFF/ONです。
- `thinkingPolicy.ambiguity`: `on` / `off`。既定は品質を優先して `on`。曖昧な範囲の扱いを明示的に変更できます。取得失敗・不正応答・タイムアウトはこの設定にかかわらずONです。
- `thinkingPolicy.timeoutMs`: 100〜10,000の整数。既定3,000ms。

`thinkingPolicy` は指定した項目だけを現在値へマージします。モデル・モード・方針をまとめて検証し、無効な値は400 `invalid_settings` で全体を拒否します。`GET settings`、履歴内の `settings`、`settings_updated` に現在のモードと方針を含みます。設定と方針は再起動・履歴削除後も保持します。

旧クライアントの `thinkingEnabled:true/false` も受理し、`on/off` として保存します。`thinkingMode` と両方を送る要求は拒否します。レスポンスの旧 `thinkingEnabled` は「常にON」の場合だけ `true` です。旧アプリは自動を表現できないのでWorkerとアプリを両方更新してください。

## Neuronsと待ち時間

judgeごとに既存の `niao_usage_attempts` へ1件を追加し、`niao_judge_attempts` にスコア・理由・待ち時間・換算根拠を記録します。チャットや判定入力の内容はこの計測表やログへ保存しません。通常の推論・ツール継続の推論と合算した値が `local.neurons` / `local.attempts` です。judge単独の内訳は `local.judge` にあります。

実際のClef-flashレスポンスでは `usage.input_tokens` と `output_tokens` が返り、Neuronsはありませんでした。`usage.neurons` が返る場合は優先し、それ以外は公式の **入力100万トークンあたり3,455 Neurons**（2026-10-29確認）を使います。

```text
judge Neurons換算値 = input_tokens × 3455 / 1,000,000
```

このレートは `src/thinking-policy.ts` の `JUDGE_NEURONS_PER_M_INPUT` で管理し、各記録にも入力トークン数と使用レートを保持します。料金変更時は更新が必要です。換算値は確定した課金実績ではありません。[Cloudflare公式料金表](https://developers.cloudflare.com/workers-ai/platform/pricing/#other-model-pricing)

アプリの「利用状況統計」→「Neurons」にjudgeのNeurons・件数・累計/平均待ち時間を表示し、換算値を含むことを明示します。メイン画面は現在値のみです。待ち時間はmsで保持し、Neuronsへ換算しません。アカウント全体のAnalyticsは既にjudgeを含むため、ローカル記録を追加加算しません。

usageを取得できない失敗・中断・タイムアウトは「使用量未取得」として件数を残します。キャンセルを無視したリクエストが後から消費した分など、取得できなかった実使用量はローカル記録に復元しません。Analyticsの全体値と併せて確認してください。

`thinking.decision` ログにはモデル・スコア・ON/OFF・判定理由・durationMs・Neurons・使用量の出所のみを出します。追加Worker、追加シークレット、Dynamic Workersは不要です。適用にはAgent Workerの再デプロイとmacOSアプリの再ビルドが必要です。
