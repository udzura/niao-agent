import SwiftUI

struct ChatView: View {
    @ObservedObject var store: ChatStore
    @State private var confirmClear = false
    @FocusState private var inputFocused: Bool
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 7) {
                Circle().fill(store.connected ? Color.green : Color.secondary).frame(width: 7, height: 7)
                Text(store.connection).font(.caption).foregroundStyle(.secondary)
                Spacer()
                if !store.connected { Button("再接続") { store.reconnect() } }
                Button { confirmClear = true } label: { Image(systemName: "trash") }
                    .disabled(!store.connected || store.busy || store.controlBusy).help("チャット履歴を削除")
                Button { store.settingsPresented = true } label: { Image(systemName: "gearshape") }.help("設定")
            }.padding(12)
            UsageView(store: store)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        if store.messages.isEmpty && !store.busy {
                            ContentUnavailableView("Niao", systemImage: "bird", description: Text("設定でバックエンドに接続して、会話を始めましょう。"))
                                .frame(maxWidth: .infinity).padding(.top, 60)
                        }
                        ForEach(store.messages) { message in
                            MessageRow(message: message)
                            if let failed = store.turns.first(where: { $0.requestId == message.requestId && $0.status == "failed" }), message.role == "user" {
                                HStack {
                                    Text(explanation(failed.errorCode ?? "unknown")).font(.caption).foregroundStyle(.secondary)
                                    Button("再試行") { store.retry(message) }.disabled(!store.connected || store.busy || store.outbox != nil)
                                }
                            }
                        }
                        if store.busy {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack { ProgressView().controlSize(.small); Text(store.toolRunning ? "Niao · Rubyで計算中" : "Niao · 生成中").font(.caption).foregroundStyle(.secondary) }
                                if let text = store.partial?.text, !text.isEmpty { Text(text).textSelection(.enabled) }
                            }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }.padding(20)
                }
                .onChange(of: store.messages.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                .onChange(of: store.partial?.text) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            }
            if let pending = store.outbox {
                HStack {
                    Text("送信確認待ち: \(pending.content)").font(.caption).lineLimit(2)
                    Spacer()
                    Button("再送") { store.resendOutbox() }.disabled(!store.connected || store.busy)
                    Button("破棄") { store.discardOutbox() }
                }.padding(12).background(.quaternary)
            }
            if let error = store.error {
                HStack(alignment: .top) {
                    Image(systemName: "exclamationmark.triangle")
                    Text(error).font(.caption).textSelection(.enabled)
                    Spacer()
                    Button { store.error = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain)
                }.foregroundStyle(.orange).padding(12)
            }
            Divider()
            HStack(alignment: .bottom, spacing: 12) {
                TextField("メッセージを入力", text: $store.draft, axis: .vertical)
                    .lineLimit(1...6).textFieldStyle(.plain).focused($inputFocused)
                    .onSubmit { store.send() }
                Button { store.send(); inputFocused = true } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .buttonStyle(.plain).disabled(!store.canSend).keyboardShortcut(.return, modifiers: .command)
                    .help("送信 (⌘Return)")
            }.padding(16)
        }
        .alert("チャット履歴を削除しますか？", isPresented: $confirmClear) {
            Button("キャンセル", role: .cancel) {}
            Button("履歴を削除", role: .destructive) { store.clearHistory() }
        } message: {
            Text("サーバー上の会話履歴と送信待ちメッセージを削除します。元に戻せません。モデル設定と使用量の記録は残ります。")
        }
        .sheet(isPresented: $store.settingsPresented) { SettingsView(store: store) }
    }
}
struct MessageRow: View {
    let message: ChatMessage
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(message.role == "user" ? "あなた" : "Niao").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(message.content).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(message.role == "user" ? Color.accentColor.opacity(0.08) : Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
        .padding(.leading, message.role == "user" ? 36 : 0)
        .padding(.trailing, message.role == "user" ? 0 : 36)
    }
}
struct SettingsView: View {
    @ObservedObject var store: ChatStore
    @Environment(\.dismiss) private var dismiss
    @State private var url = ""
    @State private var token = ""
    @State private var selectedModel = ""
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Niao の設定").font(.title2.bold())
            Form {
                TextField("バックエンド URL", text: $url)
                SecureField("アクセストークン", text: $token)
            }
            Text("トークンは接続先ごとに macOS Keychain へ保存します。ローカル開発では http://127.0.0.1:8787 を指定します。")
                .font(.caption).foregroundStyle(.secondary)
            Divider()
            if let settings = store.agentSettings {
                Text("接続中の Agent のモデル").font(.headline)
                Picker("モデル", selection: $selectedModel) {
                    ForEach(settings.models) { model in Text(model.name).tag(model.id) }
                }
                HStack {
                    Text("変更後の推論から適用されます。").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("モデルを変更") { store.updateModel(selectedModel) }
                        .disabled(!store.connected || store.controlBusy || selectedModel == settings.modelId || selectedModel.isEmpty)
                }
            }
            if let error = error ?? store.error { Text(error).font(.caption).foregroundStyle(.red) }
            HStack {
                Spacer()
                Button("キャンセル") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("保存して接続") {
                    do { try store.saveSettings(url: url, token: token); dismiss() }
                    catch { self.error = error.localizedDescription }
                }.keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 480)
        .onAppear {
            selectedModel = store.agentSettings?.modelId ?? ""
            url = store.backendURL
            do { token = try Keychain.read(backend: url) } catch { self.error = error.localizedDescription }
        }
        .onChange(of: store.agentSettings?.modelId) { _, value in selectedModel = value ?? "" }
        .onChange(of: url) { _, value in
            guard value != store.backendURL else { return }
            // Do not silently reuse a production credential for a different host.
            token = (try? Keychain.read(backend: value)) ?? ""
        }
    }
}
