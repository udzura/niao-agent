# 複数の会話セッション

1つの `NiaoAgent(personal)` のSQLiteに複数会話を保存します。Agent loopは引き続きサーバー側です。追加Worker・D1・新しいsecretは不要です。

## 使い方と保持期限

- Macは左の会話一覧、iPhoneは右上の吹き出しボタンから選択・作成します。
- 最初のユーザーメッセージの先頭40 Unicode文字を会話名にします。手動で名前変更、アーカイブ／復元、削除できます。
- 選択中の会話と下書きは端末ごとに独立します。下書きはアプリ実行中のみ会話別に保持し、確定履歴はサーバーから復元します。
- 未送信データは接続先と会話IDを付けて端末内に保存します。既存の単一outboxは `legacy` 会話のv2送信として移行します。
- 新着表示は端末ごとの最終閲覧日時から復元します。既読状態を他端末へ同期しません。
- モデル・Thinking設定と利用量はNiao全体で共通です。推論は全体で1ターンずつ。他会話を閲覧・作成できますが送信は推論終了を待ちます。
- ツール統計の「今回の起動」は会話セッションとは別です。端末で受信したツール通知を起動単位で集計します。

`updatedAt` は名前変更やアーカイブも含む更新、`lastActivityAt` は保存されたユーザー／Assistantメッセージによる活動です。閲覧・履歴同期・設定変更で活動日時を延長しません。メッセージ保存と活動日時の更新はSQLiteトリガーで同じトランザクションに含まれます。

最終活動から **30日** の会話を、Agent起動時とSDKの1時間間隔スケジュールで削除します。実際の削除はチェック時となります。`CHAT_RETENTION_DAYS`（1〜365の整数、未設定・不正値は30）で変更可能です。設定を短縮してデプロイすると次の起動／チェックで削除されます。

- アーカイブにも同じ期限が適用されます。
- 推論中、未完了の非同期取得、予約済みリマインダーがある会話は期限切れ削除を保留します。通知保存で活動日時が更新されます。
- 明示削除には確認があり、未完了ジョブ・リマインダーも削除します。対象会話の推論中は409 `busy`です。別会話の推論は妨げません。
- 履歴、Thinking、所属ジョブ・結果を削除します。共通設定と利用量記録は保持します。遅延Queue配送・RPC完了・再送では削除済み会話を再作成しません。

容量上限は50会話（アーカイブを含む）、1会話の本文＋Thinking合計8MiBです。約2,000メッセージを目安に新規送信を止め、応答・Thinking・通知のため768KiBと32メッセージ分を予約します。SQLiteトリガーも本文＋Thinkingの8MiB上限を強制します。DB全体の物理サイズではなく本文サイズの制限です。既存の大きな会話は削らず閲覧可能ですが、新しい入力を止めます。上限では `session_limit`／`session_full` を返し、古い会話を勝手に押し出しません。

## OS通知とアイコンのバッジ

設定の「ジョブ結果をOS通知とバッジで知らせる」をONにすると、OSへ通知とバッジの許可を求めます。既定はOFFで、初回起動時・単なるジョブ受信時には許可ダイアログを出しません。サウンドの許可は求めず、通知にも音を付けません。拒否後はOSのNiao通知設定で許可し、「通知の許可状態を再確認」から状態を更新できます。通知とバッジの片方のみ許可した場合も個別に尊重します。

- 既存の確定 `message_added` を受信した時だけ、`UserNotifications` のローカル通知を即時登録します。完了を知らせるアプリ内バナーは表示せず、OS通知と未読バッジに統一します。ツール実行時の短いポップ表示は継続します。
- 前面でもOSバナーと通知センターのリストに表示できます。実際の表示・プレビュー・集中モードによる抑制はOS設定に従います。
- バッジは、この端末が受信した未読の**ジョブ結果の件数**です。通常のチャットメッセージや、履歴同期で初めて取得した結果を新しい通知として加算しません。
- 会話を前面で読んでいる場合、その会話の新しい結果は既読として扱い、OS通知は出してもバッジを増やしません。他会話・非表示の会話の結果は未読へ加算します。会話の取得完了後、該当会話の未読を解除します。
- OS通知のタップは保存済みIDから会話を特定します。接続・本人確認後に移動し、既読にします。Macはチャットウィンドウも開きます。会話削除や履歴クリア後の通知は除去し、古いepochへの移動を拒否します。
- 通知の二重登録を避け、OS登録・削除・バッジ更新を直列化します。接続先変更や処理中の削除があっても、古い結果の通知を残しません。
- `notification-inbox.json` に接続先・通知ID・会話ID・epoch・既読状態と会話ごとの未読数だけを保存します。本文プレビューやトークンは保存しません。直近512件の通知IDを保持し、古いIDを整理しても会話ごとの未読件数は失いません。保存ファイルは0600、OSのファイル保護を適用します。

今回の対象は**アプリが結果を受信できる間だけ**です。iOSがバックグラウンドへ移行してWebSocketを停止している間には、新たなジョブ完了を検知できません。すでにOSへ登録した通知は通知センターで確認できます。APNs・Push Notifications capability・サーバー変更は使いません。日時を指定する端末の予約通知はpendingで、実装していません。

反映はMac／iPhoneアプリの再ビルドだけです。Workerの再デプロイは不要です。

参考: [Appleの通知許可](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications)、[ローカル通知](https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app)、[バッジ更新](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/setbadgecount(_:withcompletionhandler:))。

## 保存と移行

`niao_sessions` は `id,title,createdAt,updatedAt,lastActivityAt,archivedAt,epoch` を持ちます。既存のmessages、turns、thinking、fetch_jobs、remindersに `sessionId` を追加します。起動時のトランザクションで移行し、既存のID・seq・epochを維持して最初の `legacy` 会話へ所属させます。初期化済みマーカーを保存するため、`legacy` を削除しても再作成されません。

既存履歴の最終メッセージ日時を活動日時に使うため、30日より古く未完了ジョブもない履歴は、初回移行時から期限切れ削除の対象です。必要な履歴は更新前にバックアップしてください。

会話のseqは従来どおりDO全体のAUTOINCREMENTを使い、`(sessionId,seq)` の索引で取得します。番号に隙間があっても問題ありません。requestIdは全体で一意のまま、別会話への流用を `id_conflict` で拒否します。Thinkingも所属会話を持ち、LLM文脈は当該会話の完了済みメッセージだけから構築します。最大24メッセージ／24,000 UTF-16文字の既存文脈予算を維持します。

## HTTPとWebSocket v2

全ルートは既存Bearer認証の内側です。以下のパスは `/agents/niao-agent/personal` 配下です。

| Method | Path | 用途 |
|---|---|---|
| GET | `/sessions` | 会話カタログ、保持日数、上限、実行中会話、全会話のジョブ |
| POST | `/sessions` | `{}` または `{title}` で新規作成（201） |
| PATCH | `/sessions/:id` | `{title?,archived?}` |
| DELETE | `/sessions/:id` | 会話を削除。`If-Match: "<epoch>"` 必須 |
| GET | `/sessions/:id/history` | 指定会話だけの履歴・状態 |
| DELETE | `/sessions/:id/history` | 会話を残して履歴クリア。epochを進める |

タイトルは1〜100 Unicode文字。POST/PATCHの入力は最大2,048bytes。サーバーがUUIDを生成し、クライアント指定IDによる作成や削除済みIDの復元はできません。

履歴は最大100件／ページ。`latest=1` は最新100件と `hasOlder,beforeCursor`、`before=<seq>` はその直前の100件を返します。再接続は `after=<cursor>&epoch=<epoch>` で追いつきます。クライアントはHTTPのみで前方cursorを進め、古い履歴の読み込みで前方cursorを戻しません。

初回接続・会話切り替え・再接続では「メッセージを読み込んでいます…」を表示します。失敗時にはエラーと「再読み込み」を表示し、空の会話と区別します。読み込みごとの識別子により、切り替え前の遅い応答で現在の読み込み状態が解除されることを防ぎます。

WebSocketは既存の接続先に `?protocol=2` を付けて明示的に選びます。1本の接続で全会話のイベントを運びます。

```json
{"v":2,"type":"send","sessionId":"会話UUID","requestId":"ターンUUID","content":"こんにちは","epoch":0}
```

`accepted,partial,committed,message_added,tool_status,error,history_cleared` は所属 `sessionId` とepochを持ちます。`sessions_updated` はrevision付きカタログ、`jobs_updated` は会話ID付き全ジョブ、`session_deleted` は対象IDと `deleted/expired` の理由を持ちます。`ready` とHTTP履歴にもカタログ・ジョブが含まれます。

カタログrevisionは永続化し、再起動時にも進めます。古いHTTP／バッファ済みWSで一覧を巻き戻しません。選択会話のID・epochと端末内の選択世代を照合し、切り替え前の遅延応答を別会話へ混ぜません。非表示会話の通知はその会話へ保存し、新着を表示します。

v1の接続・HTTP履歴は `legacy` 会話だけを扱います。他会話の本文・ジョブ・会話カタログは配信しません。削除後のv1履歴は404になります。新クライアントはv2対応サーバーが必要です。通信形式とリリースバージョンは別です。

## 非同期ジョブ

Queue consumerは従来どおり `personal` AgentへjobIdで戻り、Agentのジョブ行から所属会話を決めます。Queueの既存形式は変更せず、移行前の配送も処理できます。lease token、epoch、会話存在を検査し、結果を依頼元へ保存します。要約推論は全体の推論ゲートを共有します。

会話削除は先にSQLite行を消して遅延完了を無効化し、その後、所属ジョブのSDKスケジュールを取り消します。外部で実行中のHTTP／Browser処理そのものを強制停止する保証はありませんが、その結果は保存・通知されません。

## 検証・デプロイ

```sh
npm run typecheck -w apps/worker
npm run test -w apps/worker
npm run test:macos
npm run build:worker
npm run build:macos
npm run build:ios
npm run test:ios
```

実際のworkerd/SQLiteで会話分離、移行／eviction、v1隔離、再送、全体の推論ゲート、履歴ページング、自動／明示削除、ジョブ完了先と遅延完了拒否を検証します。推論・外部サービスは明示的なテストfixtureを使い、実APIでのモデル品質を検証するテストではありません。

本番反映は **niao-agentのみ再デプロイし、その後Mac／iPhoneアプリを再ビルド**します。その他Workerの再デプロイ・WranglerのDOクラスmigration・外部D1 migrationは不要です。

```sh
npm run deploy -w apps/worker
npm run build:macos
npm run build:ios
```

自動削除の定期起動は既存Agents SDK schedulerを利用します。追加Cron TriggerやQueueは不要です。Workers Freeでの本番CPU時間・ストレージ使用量は未計測です。大量の既存履歴の初回移行はローカル検証後に反映してください。

公式の実験的 `agents/sessions` は今回採用せず、Niao既存の線形履歴・epoch・重複排除を拡張しました。会話分岐・自動圧縮は対象外です。
