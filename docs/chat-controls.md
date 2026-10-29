# モデル設定・履歴削除API

すべて既存の `NIAO_TOKEN` による Bearer 認証が必要です。追加のCloudflareシークレットは不要です。以下は `NIAO_BACKEND_URL` と `NIAO_TOKEN` を環境変数に設定済みの例です。

## モデルとthinking設定を取得・変更する

```sh
curl --fail-with-body -H "Authorization: Bearer $NIAO_TOKEN" \
  "$NIAO_BACKEND_URL/agents/niao-agent/personal/settings"

curl --fail-with-body -X PUT \
  -H "Authorization: Bearer $NIAO_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"modelId":"@cf/google/gemma-4-26b-a4b-it","thinkingMode":"auto"}' \
  "$NIAO_BACKEND_URL/agents/niao-agent/personal/settings"
```

レスポンスには `modelId`（現在の選択）、`thinkingMode`（`auto/on/off`）、`thinkingPolicy`（閾値・曖昧時方針・タイムアウト）、旧形式互換の `thinkingEnabled`、`models`（選択可能なID・表示名・`supportsThinking`）、`epoch`（会話の世代）、`v: 1` が含まれます。現在の回答モデル候補は以下の2つです。

- `@cf/google/gemma-4-26b-a4b-it`（既定）
- `@cf/zai-org/glm-4.7-flash`

モデルとthinking設定はSQLiteに永続化され、次の会話ターンから適用されます。生成中の応答は、ツール実行後の続きも含めて開始時の設定を使い続けます。失敗した応答を再試行する際は新しい設定を使用します。完了済み送信の再送には保存済みの応答を返します。

`thinkingMode` は `auto`（自動）/ `on`（常にON）/ `off`（常にOFF）です。省略すると現在値を維持します。旧 `thinkingEnabled:true/false` は `on/off` として受理しますが、`thinkingMode` と同時には指定できません。既存DBのON/OFFは保持し、新規の既定はOFFです。現在はGemma 4にのみ適用し、GLMではthinkingとjudgeを無効にします。モデルを切り替えても保存値を保持します。モデルごとの複数設定ではなく、選択中のモデルと一緒に保持する1つのオプションです。

自動ではClef-flashをターン開始時に1回だけ呼びます。`thinkingPolicy` の部分更新で閾値・曖昧時の方針・タイムアウトを変更でき、judgeの使用量と待ち時間も記録します。詳細とcurl例は[自動thinking](automatic-thinking.md)を参照してください。

thinkingのON/OFFは生成要求の設定で、OFFでもモデルがthinkingを返す場合は分離して表示します。ONでは生成時間や消費量が増える場合があります。[Googleのthinking説明](https://ai.google.dev/gemma/docs/capabilities/thinking)も参照してください。出力上限は従来の2,048トークンで、thinkingを有効にしても自動では増やしません。思考だけで終わって回答が得られない場合はエラーになります。

許可していないモデルは400で拒否します。追加候補はWorkerの `src/model.ts` の `MODELS` で管理しますが、追加前に入出力とストリーミング形式の互換性を確認してください。選択されたモデルの実行が失敗しても別モデルへ暗黙に切り替えません。

## チャットを全削除する

**この操作はサーバーの会話履歴を削除します。元に戻せません。** 生成中は409で拒否します。モデル設定・ニューロン使用量の記録は残ります。

まずGET settingsで現在の `epoch` を確認してください。例えば `epoch: 0` の場合:

```sh
curl --fail-with-body -X DELETE \
  -H "Authorization: Bearer $NIAO_TOKEN" \
  -H 'If-Match: "0"' \
  "$NIAO_BACKEND_URL/agents/niao-agent/personal/history"
```

成功例: `{"v":1,"epoch":1}`。`If-Match` は二重引用符付きの値が必須です。古い値で再送すると409になり、削除後に始まった新しい会話を誤って消しません。通信失敗時はGETで状態を再取得し、削除が必要か確認してください。

接続中のアプリへ削除を通知します。オフラインだったアプリも次の同期で削除を反映し、旧世代の送信待ちデータを破棄します。CLI等の独自クライアントは履歴と送信に `epoch` を含めてください。詳細は [protocol.md](protocol.md)。WorkerとmacOSアプリを両方更新してから使ってください。
