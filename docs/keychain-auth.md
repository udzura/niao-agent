# Keychainアクセス前の本人確認

Niaoのトークン読み書きは、LocalAuthenticationの`deviceOwnerAuthentication`で本人確認してから行います。利用可能な場合はTouch IDを使い、Macのログインパスワード等の認証方法はmacOSが選択します。Touch IDだけに限定するポリシーではありません。

## 認証のタイミング

- 起動後の最初の接続、または設定で保存済みトークンを読む・保存する前に認証します。
- 起動中はアプリ側で本人確認済みの状態を共有し、ネットワーク再接続や設定画面の読み込みごとに再認証しません。
- Mac/画面のスリープ、ユーザーセッションの切り替えで本人確認済み状態を失効させ、接続を切ります。復帰後のアクセスには改めて認証が必要です。
- 認証拒否・キャンセル・Keychainエラーは自動再試行を止めます。チャットの「再接続」や設定画面の明示操作で再試行できます。認証ダイアログから戻った際のアクティブ通知でも認証ループを起こさないようにしています。
- 設定のURL編集中はトークンを自動取得しません。接続先を変えたら「保存済みトークンを読み込む」で取得するか、新しいトークンを入力します。

Keychainの同期APIは別スレッドで実行し、認証待ちやOSの許可ダイアログでメインスレッドを塞ぎません。並行するアクセスは一度の本人確認にまとめ、ロック以前に開始した結果は利用しません。

## 保護の範囲

**これはNiaoアプリ内の本人確認ゲートです。Keychain項目自体の生体認証ACLではありません。** 現行のad-hoc署名開発ビルドとの互換性を保つため、既存のfile-based Keychain項目をそのまま使います。トークンの移行や削除は行いません。macOS標準のKeychainアクセス許可が必要な場合、そのダイアログは別途表示されます。既にアプリのメモリや設定画面に読み出した値を完全消去する機能でもありません。

OS側で項目の読み出し自体にTouch ID等を必須化する場合は、Data Protection Keychain、`SecAccessControl`、署名entitlements/provisioning、既存項目の移行を合わせて設計する必要があります。これは今回の実装には含めません。MacのKeychain実装の違いは[Apple TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)を参照してください。

## 検証

実ユーザーのKeychainや生体情報を自動テストで操作しません。依存を差し替えたセッションテストで、拒否時の読み書き防止、同時アクセスの認証集約、ロックによる失効、古い読み出し結果の破棄を確認します。実際のTouch ID/パスワード・Keychain許可ダイアログは手動確認が必要です。

手動確認:

1. アプリを再起動し、本人確認後に接続することを確認。
2. 再接続しても本人確認を繰り返さないことを確認。
3. 画面をスリープして復帰し、改めて認証が必要なことを確認。
4. 認証をキャンセルして、勝手に繰り返さず手動で再試行できることを確認。
5. 設定で別URLへ変え、入力中には認証を始めず、読み込みボタンで対応するトークンを取得することを確認。

公式資料: [KeychainとTouch ID](https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id)、[SecItemCopyMatchingのスレッド上の注意](https://developer.apple.com/documentation/security/secitemcopymatching(_:_:))。
