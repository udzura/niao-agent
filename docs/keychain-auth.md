# Keychainアクセス前の本人確認

NiaoはmacOS / iOSともにアプリ専用のData Protection Keychainへトークンを保存します。macOSでは全ての通常操作に`kSecUseDataProtectionKeychain = true`を指定します。`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`を使い、iCloudへの同期は行いません。

トークン読み書きの前に、LocalAuthenticationの`deviceOwnerAuthentication`で本人確認します。MacではTouch ID / ログインパスワード、iPhoneではFace ID / 端末パスコードなど、利用できる認証方法をOSが選択します。生体認証だけに限定するポリシーではありません。

## Mac版の署名と起動

Data Protection Keychainはアプリの署名・entitlements・プロビジョニングプロファイルに基づいてアクセスを制限します。Mac版の`Niao.entitlements`には、自分のTeamとBundle Identifierに対応するアプリ専用の`keychain-access-groups`を指定しています。旧ad-hoc署名からApple Developmentによる自動署名へ変更しています。

Xcodeで`apps/macos/Niao.xcodeproj`を開き、TARGETS → Niao → Signing & Capabilitiesで自身のTeamを設定してください。Teamの変更はトークンへのアクセスにも影響します。CLIの場合:

```sh
# 初回など、開発用プロファイルの取得・作成が必要な場合
npm run build:macos -- -allowProvisioningUpdates
open apps/macos/build/Build/Products/Debug/Niao.app
```

プロファイルがローカルに揃った後は通常の`npm run build:macos`でもビルドできます。ad-hoc署名・署名なしビルドでは実際のData Protection Keychain利用を検証できません。署名不足を理由に旧Keychainへ戻す動作はありません。

## 既存Macトークンの移行

最初にその接続先のトークンを読み出すとき、次の順序で処理します。

1. Data Protection Keychainに項目があれば、その値を使用する。
2. 項目が存在しない場合のみ、従来のfile-based Keychainを読む。
3. 旧トークンがあれば新しい保存先へ追加し、再読み出しで値を確認する。
4. 旧項目は移行後も削除せず保持する。以後は新しい保存先を優先する。

保存先のアクセスエラー・移行失敗・検証失敗ではエラーを返し、旧トークンをそのまま使って接続しません。移行中に設定画面から新しい値が保存されても、旧トークンで上書きしません。設定からの新しい保存はData Protection Keychainだけを更新します。

既存項目を見つけるため、service名`dev.niao.Niao.backend-token`は維持しています。accountは従来どおり接続先URLです。Bundle Identifierとは別の項目識別名です。

**初回の移行では、旧Keychainへのアクセス許可・パスワード入力が一度必要になる場合があります。** 移行後の通常アクセスでは旧項目を参照しません。移行を拒否した場合は、設定からトークンを改めて入力・保存する方法もあります。

iOSは元からData Protection Keychainなので移行処理を実行しません。今回の変更で端末間のトークン同期も追加しません。

## 認証のタイミングと保護の範囲

- 起動後の最初の接続、または設定で保存済みトークンを読む・保存する前に認証します。
- 起動中はアプリ側で本人確認済みの状態を共有し、ネットワーク再接続や設定画面の読み込みごとに再認証しません。
- Mac/画面のスリープ・ユーザーセッション切り替え、iOSのバックグラウンド移行で本人確認済み状態を失効させ、接続を切ります。復帰後には改めて認証します。
- 認証拒否・キャンセル・Keychainエラーは自動再試行を止めます。「再接続」や設定画面の操作で再試行できます。
- 設定のURL編集中はトークンを自動取得しません。接続先を変えたら「保存済みトークンを読み込む」で取得するか、新しいトークンを入力します。

Securityの同期APIは別スレッドで実行します。並行するアクセスの本人確認はまとめ、ロック以前に開始した結果は利用しません。

**本人確認は引き続きNiaoアプリ内のゲートです。Keychain項目に`SecAccessControl.userPresence`などの生体認証ACLを追加する変更ではありません。** Data Protection Keychainの署名に基づくアクセス制限・端末ロック時の制限と組み合わせています。既にアプリのメモリや設定画面に読み出した値を完全消去する機能ではありません。OSがパスワードを必要とする場合もあります。

## 検証

```sh
npm run test:macos
npm run build:macos -- -allowProvisioningUpdates
bash apps/macos/scripts/keychain-smoke.sh
```

単体テストでは、移行の優先順位、書き込み・読み出しの拒否、移行結果の検証、並行保存による上書き防止を検証します。既存の本人確認セッションテストも継続しています。

`keychain-smoke.sh`は、ビルド済みMacアプリの署名用entitlements・プロファイルを使った検証用アプリを作り、**UUID付きのテスト専用項目だけ**を実際のKeychainへ保存します。file-based → Data Protectionへの移行、再読み出し、更新、旧項目の保持を検証し、テスト項目を削除します。実際の接続トークンは読みません。署名証明書が複数ある場合は`NIAO_SIGNING_IDENTITY`で使用する証明書を指定できます。

今回の検証ではSwiftテスト42件、Apple Development署名付きMacビルド、実Keychainでの移行・更新・テスト項目削除が成功しました。Touch ID / パスワードの本人操作は自動化していません。

手動確認:

1. 署名付きMac版を起動し、本人確認後に接続する。既存項目があれば初回の旧Keychainアクセスを許可する。
2. 再起動して接続し、旧Keychainの許可要求が繰り返されないことを確認する。
3. 再接続では本人確認を繰り返さず、画面スリープ・復帰後には再認証することを確認する。
4. 認証をキャンセルし、自動で繰り返さず手動で再試行できることを確認する。
5. 設定から保存した新しいトークンが再起動後にも利用されることを確認する。

公式資料: [Mac KeychainのAPIと実装](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)、[Data Protection Keychainの指定](https://developer.apple.com/documentation/security/ksecusedataprotectionkeychain)、[KeychainとTouch ID](https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id)。
