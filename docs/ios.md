# Niao for iPhone

iPhone 16 Proを最初の対象にしたiOS版です。iOS 17以降・iPhone・縦画面に対応します。Xcode 27.1でビルドし、iPhone 16 Pro / iOS 27.0シミュレータで検証しています。

## 起動

```sh
open apps/ios/Niao.xcodeproj
```

Xcodeで`Niao` scheme → `iPhone 16 Pro`シミュレータ → Run。必要なiOS Simulator runtimeはXcodeのSettings → Componentsから導入してください。CLIでビルドする場合:

```sh
npm run build:ios
```

ビルド結果は`apps/ios/build/Build/Products/Debug-iphonesimulator/Niao.app`です。iPhone 16 Proシミュレータが起動済みなら:

```sh
xcrun simctl install booted apps/ios/build/Build/Products/Debug-iphonesimulator/Niao.app
xcrun simctl launch booted jp.udzura.niao.Niao
```

実機ではXcodeのSigning & Capabilitiesで自身のTeamを指定し、接続したiPhone 16 Proを選んでRunしてください。Developer Modeや端末の信頼設定、Appleの開発用署名が必要です。SimulatorビルドはKeychainを使えるようローカルのad-hoc署名を付けます（開発Teamは不要）。そのまま実機へインストールはできません。App Store / TestFlight配布はこの変更に含みません。

iOSアプリのBundle Identifierは`jp.udzura.niao.Niao`です。以前の`dev.niao.Niao`ビルドからは別アプリとして扱われるため、接続先とトークンを改めて設定してください。

## 接続

1. 右上のチャットメニュー（☰）から「設定」を開く。
2. 既存の本番AgentのHTTPS URLと、そのAgentの`NIAO_TOKEN`を入力。
3. 「保存して接続」でFace IDまたは端末パスコードによる本人確認後に接続。

この移植だけではWorkerの変更・再デプロイは不要です。同じ接続先の`personal` Agentを使うので、MacとiPhoneは同じ会話履歴・モデル・Thinking設定を共有します。新しいトークンをサーバーで作る必要はありません。Keychain・接続先URL・端末内のツール統計・送信待ちメッセージは各端末で独立しており、Macから自動移行しません。

ローカル開発は、Macで`npm run dev`を起動し、**iOSシミュレータ**から`http://127.0.0.1:8787`と`.dev.vars`の`NIAO_TOKEN`を指定できます。実機の`127.0.0.1`はiPhone自身です。URL検証は引き続きHTTPS必須（HTTPはloopbackのみ）なので、実機ではデプロイ済みHTTPSバックエンドを使ってください。

## 画面とライフサイクル

- チャット、逐次回答、Markdown、コードコピー、Thinking開閉・スライダー、ツール通知、再試行を共有。
- 右上のチャットメニューに今日のNeurons使用量、利用状況統計、設定、再接続、履歴削除を集約。統計はシートで開き、Neurons / Workers / ツールを切り替え。「完了」でチャットへ戻る。
- 入力欄の電球アイコンからThinkingスライダーを開く。通常は入力欄・Thinking・複数行切り替え・送信が1行に収まり、キーボード表示中も会話の高さを確保する。
- 会話部分（空白部分を含む）のタップで入力フォーカスとキーボードを閉じる。スクロールによるキーボードの収納も可能。
- 通常入力はキーボードの「送信」または↑で送信。「複数行で入力」で広がり、Returnは改行。↑または外付けキーボードのCtrl＋Returnで明示送信。
- バックグラウンドに移るとKeychainの本人確認済み状態を失効させ、WebSocketを切断。復帰時に本人確認・HTTP履歴同期・WebSocket再接続を行う。
- Face ID表示中の一時的な`inactive`では切断しない。キャンセル後は「再接続」から再試行。
- 新規設定時、保存トークンが存在しない場合の読み出しでは認証を要求しない。トークンの保存・保存済み値の読み出しには本人確認が必要。
- iOSでバックグラウンド通信や生成中の逐次表示を維持する仕組みは追加しない。サーバー側Agent loopの結果を復帰後の同期で取得する。通知機能は含まない。

[AppleのScenePhase](https://developer.apple.com/documentation/swiftui/scenephase)と[Face ID利用理由の設定](https://developer.apple.com/documentation/bundleresources/information-property-list/nsfaceidusagedescription)に合わせています。認証はmacOS版と同じアプリ内のゲートであり、Keychain項目自体に生体認証ACLを付ける変更ではありません。端末上でのFace ID成功・拒否・パスコードへの切り替えは実機確認が必要です。

## ソースと検証

`apps/ios/Niao.xcodeproj`は`apps/macos/Niao/`のSwiftソースを参照し、同じコードをコンパイルします。macOS固有のMenuBarExtra・ウィンドウ・NSTextView、iOS固有のScenePhase・TextEditor・UIPasteboardだけを条件コンパイルしています。画面・モデル・通信処理の複製はありません。各プラットフォームでInfo.plistとアイコンcatalogを分けています。

```sh
npm run test:ios
npm run test:macos
npm run build:macos
```

iOS UIテストはチャットメニュー、統計3種の切り替え、設定画面、Thinkingポップオーバー、単行・複数行入力からのキーボード収納、改行と下書き保持、バックグラウンド復帰を検証します。テスト起動時だけ一意な未接続URLをUserDefaults引数で指定するため、保存済み接続先の認証情報にはアクセスしません。実際のKeychain認証を迂回するテスト専用フラグや、模擬の本番応答はありません。

実際の接続確認はURLとトークン設定後、メッセージを送り、履歴・ツール呼び出し・設定変更を確認します。生成中にホームへ戻り、しばらく後に開き直して完了履歴が同期されることも確認してください。

アイコンは既存の鳥SVGを再利用し、iOS用の不透明な背景で書き出します。再生成はImageMagick導入後に`python3 apps/ios/scripts/generate-icon.py`。書き出し済みPNGを同梱しているので通常のビルド時には不要です。

今回の検証結果: iPhone 16 Pro / iOS 27.0でUIテスト1件（上記の一連の操作）が成功し、共有ロジックのSwiftテスト34件も成功しました。Simulatorビルド、実機用iOS SDKでの署名なしコンパイル、macOS版ビルドも成功しています。SimulatorでKeychain照会時の署名エラーが出ないことをUIテストで確認しています。iOS版からの実際のAI会話、トークン保存、実機のFace IDは未確認です。上の接続・手動確認手順で検証してください。

### コンパクトUIの検証（2026-11-01）

iOSでは上部を接続状態とチャットメニューの1行にし、通常の入力欄はThinking・複数行切り替え・送信を横並びにしています。macOSの配置は従来どおりです。メニュー操作、Thinkingの開閉、単行・複数行入力のフォーカス解除、改行・下書き保持をiPhone 16 Proシミュレーターで検証しました。

この実行環境ではソフトウェアキーボードが画面外に置かれるため、キーボード表示時のレイアウトテストは明示的にスキップします。実機またはソフトウェアキーボードを表示できるSimulatorで、キーボードと入力欄が重ならないこと、会話をタップして閉じられること、複数行の拡大・縮小を確認してください。

Thinkingのポップオーバーには現在設定されているモデル名も表示します。モデル変更はチャットメニューの「設定」で行います。

左上の接続状態の隣に、未完了のバックグラウンドジョブ件数を表示します。タップすると記事取得の進行状況、通知待ち、リマインダーの内容と端末の現地時刻での予定日時を確認できます。通知完了後は一覧から消えます。切断中は最後に取得した一覧と明記し、復帰時に同期します。この一覧はmacOSでも利用できます。

ジョブ表示の利用にはAgent Workerの更新とアプリの再ビルドが必要です。`npm run deploy -w apps/worker`でAgentをデプロイし、iOSはXcodeでRun、macOSは`npm run build:macos`で更新します。追加のシークレットやQueue設定は不要です。
