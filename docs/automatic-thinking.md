# Thinkingの自動判定

設定画面のThinkingで「自動／常にON／常にOFF」を選び、「モデル設定を保存」を押します。サーバーに保存し、次の会話ターンから適用します。既存のON/OFFはそれぞれ「常にON／常にOFF」へ移行し、新規設定の既定は「常にOFF」です。自動判定を使う場合は明示的に「自動」を選択してください。

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

同じターンのRubyツール実行後にも開始時の判断を使います。生成中の設定変更は次のターンへ適用します。完了済み送信の再送ではjudgeも再実行しません。失敗したターンを再試行した場合は、現在の設定で新たに1回判定し、その使用量も記録します。親ターンの90秒期限には判定時間も含めます。タイムアウト時のプロバイダー中断はbest effortで、課金の取消を保証しません。

## 設定API

既存の認証付きモデル設定APIを使用します。アプリはモードを変更でき、詳細な判定方針はAPIから調整できます。

```sh
curl --fail-with-body -X PUT \
  -H "Authorization: Bearer $NIAO_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"modelId":"@cf/google/gemma-4-26b-a4b-it","thinkingMode":"auto","thinkingPolicy":{"offThreshold":0.35,"onThreshold":0.65,"ambiguity":"on","timeoutMs":3000}}' \
  "$NIAO_BACKEND_URL/agents/niao-agent/personal/settings"
```

- `thinkingMode`: `auto` / `on` / `off`。省略すると現在値を保持します。
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

アプリの使用量詳細にjudgeのNeurons・件数・累計/平均待ち時間を表示し、換算値を含むことを明示します。待ち時間はmsで保持し、Neuronsへ換算しません。アカウント全体のAnalyticsは既にjudgeを含むため、ローカル記録を追加加算しません。

usageを取得できない失敗・中断・タイムアウトは「使用量未取得」として件数を残します。キャンセルを無視したリクエストが後から消費した分など、取得できなかった実使用量はローカル記録に復元しません。Analyticsの全体値と併せて確認してください。

`thinking.decision` ログにはモデル・スコア・ON/OFF・判定理由・durationMs・Neurons・使用量の出所のみを出します。追加Worker、追加シークレット、Dynamic Workersは不要です。適用にはAgent Workerの再デプロイとmacOSアプリの再ビルドが必要です。
