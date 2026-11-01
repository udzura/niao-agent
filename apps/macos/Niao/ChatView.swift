import SwiftUI
#if os(macOS)
import AppKit
#endif

struct ChatView: View {
    @ObservedObject var store: ChatStore
    #if os(macOS)
    @Environment(\.openWindow) private var openWindow
    #else
    @State private var statisticsPresented = false
    @State private var menuPresented = false
    @State private var thinkingPresented = false
    #endif
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var multiline = false
    @State private var confirmClear = false
    @State private var jobsPresented = false
    @FocusState private var inputFocused: Bool
    var body: some View {
        VStack(spacing: 0) {
            #if os(iOS)
            mobileHeader
            #else
            HStack(spacing: 7) {
                Circle().fill(store.connected ? Color.green : Color.secondary).frame(width: 7, height: 7)
                Text(store.connection).font(.caption).foregroundStyle(.secondary)
                backgroundJobsButton
                Spacer()
                if !store.connected { Button("再接続") { store.reconnect() } }
                Button { showStatistics() } label: { Image(systemName: "chart.bar").touchTarget() }
                    .help("利用状況統計").accessibilityLabel("利用状況統計を開く")
                Button { confirmClear = true } label: { Image(systemName: "trash").touchTarget() }
                    .disabled(!store.connected || store.busy || store.controlBusy).help("チャット履歴を削除").accessibilityLabel("チャット履歴を削除")
                Button { store.settingsPresented = true } label: { Image(systemName: "gearshape").touchTarget() }.help("設定").accessibilityLabel("設定")
            }.padding(12)
            UsageView(store: store)
            #endif
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
                                    Text(explanation(failed.errorCode ?? "unknown", details: failed.errorDetails)).font(.caption).foregroundStyle(.secondary)
                                    Button("再試行") { store.retry(message) }.disabled(!store.connected || store.busy || store.controlBusy || store.outbox != nil)
                                }
                            }
                        }
                        if store.busy {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    ProgressView().controlSize(.small)
                                    Text(verbatim: store.runningToolName.map { "Niao · \($0) を実行中" } ?? "Niao · 生成中")
                                        .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                                }
                                ThinkingDisclosureView(segments: store.partial?.thinking ?? [])
                                if let text = store.partial?.text, !text.isEmpty { ChatMarkdownView(content: text) }
                            }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }.padding(20)
                }
                .onChange(of: store.messages.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                .onChange(of: store.partial?.text) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                #if os(iOS)
                .contentShape(Rectangle())
                .simultaneousGesture(TapGesture().onEnded { inputFocused = false })
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: inputFocused) { _, focused in if focused { proxy.scrollTo("bottom", anchor: .bottom) } }
                #endif
            }
            .overlay(alignment: .bottomTrailing) { ToolCallToastOverlay(store: store) }
            if let pending = store.outbox {
                HStack {
                    Text("送信確認待ち: \(pending.content)").font(.caption).lineLimit(2)
                    Spacer()
                    Button("再送") { store.resendOutbox() }.disabled(!store.connected || store.busy || store.controlBusy)
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
            messageComposer
        }
        .onChange(of: store.backgroundJobs?.items.isEmpty) { _, empty in
            if empty != false { jobsPresented = false }
        }
        .alert("チャット履歴を削除しますか？", isPresented: $confirmClear) {
            Button("キャンセル", role: .cancel) {}
            Button("履歴を削除", role: .destructive) { store.clearHistory() }
        } message: {
            Text("サーバー上の会話履歴と送信待ちメッセージを削除します。元に戻せません。モデル設定と使用量の記録は残ります。")
        }
        .sheet(isPresented: $store.settingsPresented) { SettingsView(store: store) }
        #if os(iOS)
        .sheet(isPresented: $statisticsPresented) {
            NavigationStack {
                UsageStatisticsView(store: store)
                    .navigationTitle("利用状況統計")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完了") { statisticsPresented = false } } }
            }
        }
        #endif
    }
    @ViewBuilder private var backgroundJobsButton: some View {
        if let snapshot = store.backgroundJobs, !snapshot.items.isEmpty {
            Button {
                inputFocused = false
                jobsPresented = true
            } label: {
                Label("\(snapshot.items.count)件", systemImage: "clock.arrow.circlepath")
                    .font(.caption).touchTarget()
            }
            .buttonStyle(.plain).foregroundStyle(store.connected ? Color.accentColor : Color.secondary)
            .accessibilityLabel("バックグラウンドのジョブ")
            .accessibilityValue("\(snapshot.items.count)件" + (store.connected ? "" : "、前回取得値"))
            .popover(isPresented: $jobsPresented) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("バックグラウンド").font(.headline)
                    if !store.connected {
                        Text("前回取得した状態です。再接続すると更新します。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            ForEach(store.backgroundJobs?.items ?? []) { job in
                                VStack(alignment: .leading, spacing: 5) {
                                    Label(job.label, systemImage: job.icon).font(.subheadline.weight(.semibold))
                                    Text(verbatim: job.title).font(.subheadline).lineLimit(3)
                                    Text(job.statusLabel).font(.caption).foregroundStyle(.secondary)
                                    if let due = job.scheduledDate {
                                        Text(due, format: .dateTime.month().day().hour().minute())
                                            .font(.caption).foregroundStyle(.secondary)
                                        if due <= Date() {
                                            Text("会話の区切りで通知します").font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }.frame(maxHeight: 320)
                }
                .padding(20).frame(width: 320)
                #if os(iOS)
                .presentationCompactAdaptation(.popover)
                #endif
            }
        }
    }
    private func showStatistics() {
        #if os(macOS)
        openWindow(id: "usage-statistics")
        #else
        inputFocused = false
        statisticsPresented = true
        #endif
    }
    @ViewBuilder private var messageComposer: some View {
        #if os(iOS)
        mobileComposer
        #else
        desktopComposer
        #endif
    }
    private var desktopComposer: some View {
        VStack(alignment: .leading, spacing: 10) {
            ThinkingSlider(store: store)
            HStack(alignment: .bottom, spacing: 12) {
                if multiline {
                    multilineInput
                        .frame(height: 150)
                        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
                        .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.secondary.opacity(0.15)) }
                        .transition(.opacity)
                } else {
                    #if os(iOS)
                    TextField("メッセージを入力", text: $store.draft)
                        .textFieldStyle(.plain).focused($inputFocused).submitLabel(.send)
                        .onSubmit { store.send() }
                        .accessibilityIdentifier("message-input")
                        .transition(.opacity)
                    #else
                    TextField("メッセージを入力", text: $store.draft, axis: .vertical)
                        .lineLimit(1...3).textFieldStyle(.plain).focused($inputFocused)
                        .onSubmit { store.send() }
                        .onKeyPress(keys: [.return], phases: .down) { press in
                            guard press.modifiers == .command else { return .ignored }
                            store.send()
                            return .handled
                        }
                        .transition(.opacity)
                    #endif
                }
                Button { store.send(); inputFocused = true } label: { Image(systemName: "arrow.up.circle.fill").font(.title2).touchTarget() }
                    .buttonStyle(.plain).disabled(!store.canSend).keyboardShortcut(.return, modifiers: .control)
                    .help("送信 (Ctrl＋Enter / ⌘Return)").accessibilityLabel("送信")
            }.clipped()
            HStack {
                Button {
                    withAnimation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.88)) {
                        multiline.toggle()
                    }
                    if !multiline { Task { @MainActor in inputFocused = true } }
                } label: {
                    Label(multiline ? "入力欄を縮める" : "複数行で入力",
                          systemImage: multiline ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                }.buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
                .accessibilityValue(multiline ? "複数行モード" : "通常モード")
                Spacer()
                #if os(macOS)
                Text(multiline ? "Enterで改行 · Ctrl＋Enterで送信" : "Enterで送信")
                    .font(.caption).foregroundStyle(.secondary)
                #else
                if multiline { Text("改行できます").font(.caption).foregroundStyle(.secondary) }
                #endif
            }
        }.padding(16)
    }
    #if os(iOS)
    private var mobileHeader: some View {
        HStack(spacing: 7) {
            Circle().fill(store.connected ? Color.green : Color.secondary).frame(width: 7, height: 7)
            Text(store.connection).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            backgroundJobsButton
            Spacer()
            Button {
                inputFocused = false
                menuPresented = true
            } label: {
                Image(systemName: "line.3.horizontal").touchTarget()
            }
            .accessibilityLabel("チャットメニュー")
            .popover(isPresented: $menuPresented, arrowEdge: .top) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Niao").font(.headline).padding(.horizontal, 12)
                    UsageView(store: store)
                    Divider()
                    menuAction("利用状況統計を開く", icon: "chart.bar") { showStatistics() }
                    menuAction("設定", icon: "gearshape") { store.settingsPresented = true }
                    if !store.connected {
                        menuAction("再接続", icon: "arrow.clockwise") { store.reconnect() }
                    }
                    Divider()
                    Button(role: .destructive) {
                        menuPresented = false
                        confirmClear = true
                    } label: {
                        Label("チャット履歴を削除", systemImage: "trash")
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .disabled(!store.connected || store.busy || store.controlBusy)
                }
                .buttonStyle(.plain).padding(16).frame(width: 320)
                .presentationCompactAdaptation(.popover)
            }
        }.padding(.horizontal, 16)
    }
    private func menuAction(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button {
            menuPresented = false
            action()
        } label: {
            Label(title, systemImage: icon)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
        }
    }
    private var mobileComposer: some View {
        VStack(spacing: 6) {
            if multiline {
                multilineInput
                    .frame(height: 100)
                    .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 12))
                    .transition(.opacity)
            }
            HStack(alignment: .center, spacing: 2) {
                if multiline {
                    Text("改行できます").font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                } else {
                    TextField("メッセージを入力", text: $store.draft)
                        .textFieldStyle(.plain).focused($inputFocused).submitLabel(.send)
                        .onSubmit { store.send() }
                        .accessibilityIdentifier("message-input")
                        .frame(minHeight: 44)
                        .transition(.opacity)
                }
                Button {
                    inputFocused = false
                    thinkingPresented = true
                } label: {
                    Image(systemName: "brain")
                        .foregroundStyle((store.agentSettings?.thinkingChoice ?? .off) == .off ? Color.secondary : Color.accentColor)
                        .touchTarget()
                }
                .accessibilityLabel("Thinkingを調整")
                .accessibilityValue(store.agentSettings?.thinkingChoice.label ?? "未取得")
                .popover(isPresented: $thinkingPresented, arrowEdge: .bottom) {
                    ThinkingSlider(store: store, compact: true)
                        .padding(20).frame(width: 320)
                        .presentationCompactAdaptation(.popover)
                }
                Button {
                    withAnimation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.88)) {
                        multiline.toggle()
                    }
                    // The replacement editor must be mounted before assigning focus.
                    inputFocused = false
                    Task { @MainActor in
                        await Task.yield()
                        inputFocused = true
                    }
                } label: {
                    Image(systemName: multiline ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                        .touchTarget()
                }
                .accessibilityLabel(multiline ? "入力欄を縮める" : "複数行で入力")
                .accessibilityValue(multiline ? "複数行モード" : "通常モード")
                Button { store.send(); inputFocused = true } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title2).touchTarget()
                }
                .disabled(!store.canSend).keyboardShortcut(.return, modifiers: .control)
                .accessibilityLabel("送信")
            }.buttonStyle(.plain)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }
    #endif

    @ViewBuilder private var multilineInput: some View {
        #if os(macOS)
        MultilineMessageInput(text: $store.draft, onSend: { store.send() })
        #else
        TextEditor(text: $store.draft)
            .scrollContentBackground(.hidden).focused($inputFocused)
            .padding(4).accessibilityLabel("メッセージを入力（複数行）")
            .accessibilityIdentifier("multiline-input")
        #endif
    }

}
#if os(macOS)
// NSTextView keeps Return/IME handling native. Only an explicit modified Return sends.
struct MultilineMessageInput: NSViewRepresentable {
    @Binding var text: String
    let onSend: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        let editor = MessageTextView()
        editor.isRichText = false
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.font = .preferredFont(forTextStyle: .body)
        editor.textColor = .labelColor
        editor.drawsBackground = false
        editor.textContainerInset = NSSize(width: 6, height: 8)
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        editor.allowsUndo = true
        editor.setAccessibilityLabel("メッセージを入力（複数行）")
        editor.string = text
        editor.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
        editor.delegate = context.coordinator
        editor.onSend = onSend
        scroll.documentView = editor
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let editor = scroll.documentView as? MessageTextView else { return }
        editor.onSend = onSend
        if editor.string != text {
            editor.string = text
            editor.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
        }
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MultilineMessageInput
        init(_ parent: MultilineMessageInput) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            if let editor = notification.object as? NSTextView { parent.text = editor.string }
        }
    }
}
final class MessageTextView: NSTextView {
    var onSend: () -> Void = {}
    private func isSend(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.numericPad, .function])
        return [36, 76].contains(event.keyCode) && (flags == .control || flags == .command)
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard isSend(event) else { return super.performKeyEquivalent(with: event) }
        // Confirming a Japanese composition must never submit the draft.
        if !hasMarkedText() { onSend() }
        return true
    }
    override func keyDown(with event: NSEvent) {
        if isSend(event) {
            if !hasMarkedText() { onSend() }
        } else { super.keyDown(with: event) }
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil {
            DispatchQueue.main.async { [weak self] in
                guard let self, let window = self.window else { return }
                window.makeFirstResponder(self)
            }
        }
    }
}

#endif

// Keep the draft position local while dragging; save only the final choice.
struct ThinkingSlider: View {
    @ObservedObject var store: ChatStore
    var compact = false
    @State private var position: Double = 0
    @State private var editing = false
    private static let choices: [ThinkingChoice] = [.off, .automaticSelective, .automatic, .automaticFrequent, .on]
    private var saved: ThinkingChoice { store.agentSettings?.thinkingChoice ?? .off }
    private var selected: ThinkingChoice { Self.choices[min(4, max(0, Int(position.rounded())))] }
    private var enabled: Bool {
        store.connected && !store.controlBusy &&
        store.agentSettings?.models.first(where: { $0.id == store.agentSettings?.modelId })?.supportsThinking == true
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if compact {
                VStack(alignment: .leading, spacing: 4) {
                    Text("現在のモデル").font(.caption).foregroundStyle(.secondary)
                    Text(store.agentSettings.flatMap { settings in
                        settings.models.first { $0.id == settings.modelId }?.name ?? settings.modelId
                    } ?? "未取得")
                    .font(.subheadline.weight(.semibold)).textSelection(.enabled)
                    .accessibilityIdentifier("thinking-model-name")
                }
                Divider()
                selectionLabel
            }
            sliderRow
        }
        .onAppear { restorePosition() }
        .onChange(of: store.agentSettings?.thinkingChoice) { _, _ in if !editing { restorePosition() } }
        .onChange(of: store.controlBusy) { _, busy in if !busy && !editing { restorePosition() } }
        .onChange(of: store.connected) { _, connected in
            if !connected { editing = false; restorePosition() }
        }
    }
    private var selectionLabel: some View {
        HStack(spacing: 4) {
            Text("Thinking:")
            Text(editing ? selected.label : saved.label).foregroundStyle(.secondary)
        }.font(.caption)
    }
    private var sliderRow: some View {
        HStack(spacing: 8) {
            Text("OFF").font(.caption2).foregroundStyle(.secondary)
            Slider(value: Binding(get: { position }, set: { value in
                position = value
                // Keyboard and accessibility adjustments can arrive outside a drag.
                if !editing { save() }
            }), in: 0...4, step: 1, onEditingChanged: { active in
                editing = active
                if !active { save() }
            })
            .controlSize(.small)
            #if os(macOS)
            .frame(minWidth: 100, idealWidth: 200, maxWidth: 220)
            #else
            .frame(minWidth: 60, idealWidth: 160, maxWidth: 220)
            #endif
            .disabled(!enabled)
            .accessibilityLabel("Thinking")
            .accessibilityValue(editing ? selected.label : saved.label)
            .help("左端は常にOFF、中央3段階は自動（控えめ・標準・多め）、右端は常にON。変更は次のターンから適用します。")
            Text("ON").font(.caption2).foregroundStyle(.secondary)
            if !compact { selectionLabel.fixedSize() }
            if store.controlBusy { ProgressView().controlSize(.small) }
            Spacer(minLength: 0)
        }
    }
    private func restorePosition() {
        // Custom API policies stay untouched until the user explicitly moves the slider.
        position = Double(Self.choices.firstIndex(of: saved) ?? 2)
    }
    private func save() {
        guard enabled, selected != saved else { return }
        store.updateThinking(selected)
    }
}

struct MessageRow: View {
    let message: ChatMessage
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(message.role == "user" ? "あなた" : "Niao").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if message.role == "assistant" { ThinkingDisclosureView(segments: message.thinking ?? []) }
            ChatMarkdownView(content: message.content)
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
    @State private var credentialBusy = false
    @State private var selectedModel = ""
    @State private var error: String?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Niao の設定").font(.title2.bold())
                VStack(alignment: .leading, spacing: 4) {
                    Text("アプリ: \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "不明")")
                    Text("サーバー: \(store.agentSettings?.serverVersion ?? "未取得（旧サーバーは非対応）")")
                    if !store.connected && store.agentSettings?.serverVersion != nil {
                        Text("サーバーは前回接続時のバージョンです。")
                    }
                }.font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                VStack(alignment: .leading, spacing: 12) {
                    Text("接続先").font(.caption).foregroundStyle(.secondary)
                    TextField("バックエンド URL", text: $url)
                        .accessibilityIdentifier("backend-url")
                        #if os(iOS)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        #endif
                    SecureField("アクセストークン", text: $token)
                        .accessibilityIdentifier("backend-token")
                        #if os(iOS)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        #endif
                }.textFieldStyle(.roundedBorder).disabled(credentialBusy)
                Button("保存済みトークンを読み込む") { Task { await loadToken() } }
                    .disabled(credentialBusy)
                Text(credentialDescription)
                    .font(.caption).foregroundStyle(.secondary)
                Divider()
                if let settings = store.agentSettings {
                    Text("接続中の Agent のモデル設定").font(.headline)
                    Picker("モデル", selection: $selectedModel) {
                        ForEach(settings.models) { model in Text(model.name).tag(model.id) }
                    }
                    Text("Thinkingはチャットの入力欄から変更できます。Gemma 4・Qwenで利用でき、自動判定にはClef-flashの時間・使用量が発生します。")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Text("変更後の推論から適用されます。").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("モデル設定を保存") { store.updateModelSettings(selectedModel) }
                            .disabled(!store.connected || store.controlBusy || selectedModel.isEmpty ||
                                      selectedModel == settings.modelId)
                    }
                }
                if let error = error ?? store.error { Text(error).font(.caption).foregroundStyle(.red) }
                HStack {
                    Spacer()
                    Button("キャンセル") { dismiss() }.keyboardShortcut(.cancelAction).disabled(credentialBusy)
                    Button("保存して接続") {
                        credentialBusy = true
                        Task {
                            defer { credentialBusy = false }
                            do { try await store.saveSettings(url: url, token: token); dismiss() }
                            catch { self.error = error.localizedDescription }
                        }
                    }.keyboardShortcut(.defaultAction).disabled(credentialBusy)
                }
            }.padding(24)
        }
        #if os(macOS)
        .frame(width: 480, height: 600)
        #endif
        .interactiveDismissDisabled(credentialBusy)
        .onAppear {
            selectedModel = store.agentSettings?.modelId ?? ""
            url = store.backendURL
        }
        .task { await loadToken() }
        .onChange(of: store.agentSettings?.modelId) { _, value in selectedModel = value ?? "" }
        .onChange(of: url) { _, value in
            guard value != store.backendURL else { return }
            // Reading a saved credential is explicit; don't prompt on every keystroke.
            token = ""
            error = nil
        }
    }
    private var credentialDescription: String {
        #if os(iOS)
        "トークンはこのiPhoneのKeychainへ保存します。アクセス前にFace IDまたは端末のパスコードで本人確認します。"
        #else
        "トークンは接続先ごとに macOS Keychain へ保存します。アクセス前にTouch IDまたはMacのパスワードで本人確認します。"
        #endif
    }
    @MainActor private func loadToken() async {
        guard !credentialBusy else { return }
        credentialBusy = true
        defer { credentialBusy = false }
        do {
            let backend = try BackendURL.validate(url).absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let saved = try await Keychain.read(backend: backend)
            try Task.checkCancellation()
            token = saved
            error = nil
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }

}

private extension View {
    @ViewBuilder func touchTarget() -> some View {
        #if os(iOS)
        self.frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        #else
        self
        #endif
    }
}
