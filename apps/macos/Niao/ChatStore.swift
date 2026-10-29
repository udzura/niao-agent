import AppKit
import Combine
import Foundation

@MainActor
final class ChatStore: ObservableObject {
    @Published var toolToast = ToolCallToastState()
    @Published var toolStatistics = ToolStatistics()
    @Published var toolStatisticsError: String?
    private(set) var toolSessionID = UUID()
    private var toolStatisticsURL: URL?
    private var statisticsWritable = true
    @Published var agentSettings: AgentSettings?
    @Published var controlBusy = false
    @Published var toolRunning = false
    private var historyEpoch: Int?
    @Published var messages: [ChatMessage] = []
    @Published var usage: UsageSnapshot?
    @Published var usageError: String?
    @Published var usageLoading = false
    private var usageTask: Task<Void, Never>?
    private var backend: Backend?
    private var usageRefreshAt: Date?
    @Published var draft = ""
    @Published var connection = "未接続"
    @Published var connected = false
    @Published var error: String?
    @Published var partial: PartialMessage?
    @Published var turns: [Turn] = []
    @Published var outbox: Submission?
    @Published var backendURL = UserDefaults.standard.string(forKey: "backendURL") ?? "http://127.0.0.1:8787"
    @Published var settingsPresented = false
    private var loop: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var generation = UUID()
    private var cursor = 0 // Only HTTP advances the cursor, never WebSocket arrival order.
    private var retryAttempt = 0
    private var eventRevision = 0
    private let outboxURL: URL

    init() {
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Niao")
        outboxURL = folder.appendingPathComponent("outbox.json")
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            toolStatisticsURL = folder.appendingPathComponent("tool-statistics.json")
            do { toolStatistics = try ToolStatistics.load(from: toolStatisticsURL!) }
            catch {
                statisticsWritable = false
                toolStatisticsError = "統計ファイルを読み込めませんでした。既存ファイルを保護するため保存を停止しています。"
            }
            if let data = try? Data(contentsOf: outboxURL) {
                let stored = try JSONDecoder().decode(StoredSubmission.self, from: data)
                if stored.backend == backendURL { outbox = stored.submission }
            }
        } catch { self.error = "未送信メッセージの復元に失敗しました。\(error.localizedDescription)" }
        toolSessionID = toolStatistics.beginSession()
        saveToolStatistics()
        NotificationCenter.default.addObserver(self, selector: #selector(wake), name: NSApplication.didBecomeActiveNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(wake), name: NSWorkspace.didWakeNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(sleep), name: NSWorkspace.willSleepNotification, object: nil)
    }
    var busy: Bool { partial != nil || turns.contains { $0.status == "running" } }
    var canSend: Bool { connected && !controlBusy && !busy && outbox == nil && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.utf16.count <= 8000 }

    func saveSettings(url: String, token: String) throws {
        let valid = try BackendURL.validate(url).absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let secret = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard secret.count >= 32, !secret.contains("\n"), !secret.contains("\r") else { throw NiaoError.configuration }
        // Keep an uncertain send tied to its original server rather than sending it elsewhere.
        if valid != backendURL && outbox != nil {
            throw NSError(domain: "Niao", code: 1, userInfo: [NSLocalizedDescriptionKey: "未送信メッセージを再送するか破棄してから接続先を変更してください。"])
        }
        try Keychain.save(secret, backend: valid)
        backendURL = valid
        UserDefaults.standard.set(valid, forKey: "backendURL")
        messages = []; cursor = 0; turns = []; partial = nil
        historyEpoch = nil; agentSettings = nil
        toolToast.clear()
        usage = nil; usageError = nil; usageRefreshAt = nil
        reconnect()
    }
    func start() { if loop == nil { reconnect() } }
    @objc private func wake() { if !connected { reconnect() } }
    @objc private func sleep() { disconnect(); connection = "スリープ中" }
    private func disconnect() {
        generation = UUID()
        controlBusy = false
        toolRunning = false
        usageTask?.cancel(); usageTask = nil; usageLoading = false
        backend = nil
        loop?.cancel(); loop = nil
        heartbeat?.cancel(); heartbeat = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        connected = false
        partial = nil
    }
    func reconnect() {
        disconnect()
        let id = generation
        loop = Task { [weak self] in await self?.run(id: id) }
    }
    private func run(id: UUID) async {
        defer { if generation == id { loop = nil } }
        while !Task.isCancelled && generation == id {
            do {
                connection = retryAttempt == 0 ? "接続中…" : "再接続中…"
                let base = try BackendURL.validate(backendURL)
                let token = try Keychain.read(backend: backendURL)
                guard token.count >= 32 else { throw NiaoError.configuration }
                let backend = Backend(baseURL: base, token: token)
                self.backend = backend
                // Auth check before the upgrade gives a useful 401 message to the UI.
                try await synchronize(backend, id: id)
                let ws = backend.socket()
                socket = ws
                let ready = try await Backend.event(from: ws)
                guard ready.type == "ready", ready.v == 1 else { throw NiaoError.protocolMismatch }
                // Subscribe before the final sync: events during HTTP are queued by URLSession.
                try await synchronize(backend, id: id)
                guard generation == id, !Task.isCancelled else { return }
                connected = true; connection = "接続済み"; error = nil; retryAttempt = 0
                refreshUsage()
                if let pending = outbox, !messages.contains(where: { $0.requestId == pending.requestId }) {
                    try await transmit(pending, on: ws)
                }
                heartbeat = Task { [weak self] in
                    while !Task.isCancelled {
                        do {
                            try await Task.sleep(for: .seconds(20))
                            let deadline = Task {
                                try await Task.sleep(for: .seconds(10))
                                ws.cancel(with: .goingAway, reason: nil)
                            }
                            do {
                                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                                    ws.sendPing { error in
                                        if let error { continuation.resume(throwing: error) }
                                        else { continuation.resume() }
                                    }
                                }
                            }
                            catch { deadline.cancel(); throw error }
                            deadline.cancel()
                            try await self?.synchronize(backend, id: id)
                            self?.refreshUsageIfNeeded()
                        } catch {
                            if !Task.isCancelled { ws.cancel(with: .goingAway, reason: nil) }
                            return
                        }
                    }
                }
                while !Task.isCancelled {
                    let event = try await Backend.event(from: ws)
                    guard generation == id else { return }
                    handle(event)
                }
            } catch {
                guard generation == id, !Task.isCancelled else { return }
                connected = false; partial = nil; toolRunning = false; connection = "未接続"
                self.error = error.localizedDescription
                heartbeat?.cancel(); heartbeat = nil
                socket?.cancel(with: .goingAway, reason: nil); socket = nil
                if case NiaoError.unauthorized = error { return }
                if case NiaoError.configuration = error { return }
                retryAttempt += 1
                let delay = min(pow(2.0, Double(min(retryAttempt, 5))), 30) + Double.random(in: 0...1)
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            }
        }
    }
    private func synchronize(_ backend: Backend, id: UUID) async throws {
        var more = true
        while more {
            let revision = eventRevision
            let page = try await backend.history(after: cursor, epoch: historyEpoch)
            guard generation == id, !Task.isCancelled else { throw CancellationError() }
            guard acceptEpoch(page.epoch ?? 0) else { continue }
            messages = mergeMessages(messages, page.messages)
            cursor = page.cursor
            // A response started before a socket event must not roll back its status.
            if eventRevision == revision {
                agentSettings = page.settings
                turns = page.turns
                partial = page.active
            }
            more = page.hasMore
        }
        if let pending = outbox, messages.contains(where: { $0.requestId == pending.requestId }) { clearOutbox() }
    }
    private func handle(_ event: ServerEvent) {
        guard event.v == 1 else { return } // Ignore SDK housekeeping if introduced later.
        guard acceptEpoch(event.epoch ?? 0) else { return }
        eventRevision += 1
        switch event.type {
        case "tool_status":
            toolRunning = event.status == "running"
            if let requestID = event.requestId, let name = event.name, let status = event.status {
                let newCall = toolStatistics.observe(sessionID: toolSessionID, backend: backendURL, epoch: event.epoch ?? 0,
                                       requestID: requestID, name: name, status: status)
                if newCall { toolToast.show(name: name) }
                saveToolStatistics()
            }
        case "history_cleared": break // acceptEpoch already reset the local conversation.
        case "settings_updated": agentSettings = event.settings
        case "accepted":
            if let message = event.message {
                messages = mergeMessages(messages, [message])
                turns.removeAll { $0.requestId == message.requestId }
                turns.append(Turn(requestId: message.requestId, status: "running", errorCode: nil))
                if outbox?.requestId == message.requestId { clearOutbox() }
            }
        case "partial":
            if let requestID = event.requestId { partial = PartialMessage(requestId: requestID, text: event.text ?? "") }
        case "committed":
            toolRunning = false
            finishToolTurn(event)
            messages = mergeMessages(messages, event.messages ?? [])
            turns.removeAll { $0.requestId == event.requestId }
            if partial?.requestId == event.requestId { partial = nil }
            if outbox?.requestId == event.requestId { clearOutbox() }
            refreshUsage()
        case "error":
            toolRunning = false
            finishToolTurn(event)
            refreshUsage()
            error = explanation(event.code ?? "unknown")
            if let requestID = event.requestId {
                turns.removeAll { $0.requestId == requestID }
                if messages.contains(where: { $0.requestId == requestID && $0.role == "user" }) {
                    turns.append(Turn(requestId: requestID, status: "failed", errorCode: event.code))
                }
                if partial?.requestId == requestID { partial = nil }
            }
        default: break
        }
    }
    private func finishToolTurn(_ event: ServerEvent) {
        if let requestID = event.requestId {
            toolStatistics.finishTurn(backend: backendURL, epoch: event.epoch ?? 0, requestID: requestID)
        }
    }
    private func saveToolStatistics() {
        guard statisticsWritable, let url = toolStatisticsURL else { return }
        do { try toolStatistics.save(to: url); toolStatisticsError = nil }
        catch { toolStatisticsError = "統計の保存に失敗しました。表示中の値はメモリ上の記録です。" }
    }
    // Epochs fence old HTTP replies, buffered socket events and persisted offline sends.
    @discardableResult
    private func acceptEpoch(_ incoming: Int) -> Bool {
        if let current = historyEpoch, incoming < current { return false }
        if let current = historyEpoch, incoming > current {
            messages = []; turns = []; partial = nil; cursor = 0; draft = ""
            toolToast.clear()
        }
        historyEpoch = incoming
        if let pending = outbox, (pending.epoch ?? 0) != incoming { clearOutbox() }
        return true
    }
    func updateModel(_ modelId: String) {
        guard connected, !controlBusy, let backend else { return }
        controlBusy = true
        let id = generation
        let revision = eventRevision
        Task {
            defer { if generation == id { controlBusy = false } }
            do {
                let settings = try await backend.updateModel(modelId)
                guard generation == id else { return }
                if eventRevision == revision { agentSettings = settings }
                error = nil
            } catch {
                guard generation == id else { return }
                self.error = error.localizedDescription
            }
        }
    }
    func clearHistory() {
        guard connected, !busy, !controlBusy, let backend, let epoch = historyEpoch else { return }
        controlBusy = true
        let id = generation
        Task {
            defer { if generation == id { controlBusy = false } }
            do {
                let result = try await backend.clearHistory(epoch: epoch)
                guard generation == id else { return }
                acceptEpoch(result.epoch)
                error = nil
            } catch {
                guard generation == id else { return }
                self.error = error.localizedDescription
                // A failed/lost response may have committed. Reconcile before another action.
                reconnect()
            }
        }
    }
    private func refreshUsageIfNeeded() {
        if usage?.isCurrent() == false || Date().timeIntervalSince(usageRefreshAt ?? .distantPast) >= 60 {
            refreshUsage()
        }
    }
    func refreshUsage() {
        guard usageTask == nil, let backend else { return }
        let id = generation
        usageLoading = true
        usageTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if generation == id { usageTask = nil; usageLoading = false }
            }
            do {
                let snapshot = try await backend.usage()
                guard generation == id, !Task.isCancelled else { return }
                usage = snapshot; usageError = nil; usageRefreshAt = Date()
            } catch {
                guard generation == id, !Task.isCancelled else { return }
                // Usage errors must not disconnect an otherwise healthy chat.
                usageError = "使用量を更新できませんでした。"; usageRefreshAt = Date()
            }
        }
    }
    func send() {
        guard canSend else { return }
        let pending = Submission(requestId: UUID().uuidString.lowercased(), content: draft.trimmingCharacters(in: .whitespacesAndNewlines), epoch: historyEpoch)
        do { try persistOutbox(pending); draft = ""; sendPending(pending) }
        catch { self.error = error.localizedDescription }
    }
    func retry(_ message: ChatMessage) {
        guard connected, !controlBusy, !busy, outbox == nil else { return }
        let pending = Submission(requestId: message.requestId, content: message.content, epoch: historyEpoch)
        do { try persistOutbox(pending); sendPending(pending) }
        catch { self.error = error.localizedDescription }
    }
    func resendOutbox() { if let pending = outbox, connected, !controlBusy, !busy { sendPending(pending) } }
    func discardOutbox() { clearOutbox() }
    private func sendPending(_ pending: Submission) {
        guard let ws = socket else { return }
        error = nil
        let id = generation
        Task {
            do { try await transmit(pending, on: ws) }
            catch {
                guard generation == id else { return }
                self.error = error.localizedDescription; reconnect()
            }
        }
    }
    private func transmit(_ pending: Submission, on ws: URLSessionWebSocketTask) async throws {
        let data = try JSONEncoder().encode(pending)
        try await ws.send(.string(String(decoding: data, as: UTF8.self)))
    }
    private func persistOutbox(_ pending: Submission) throws {
        let data = try JSONEncoder().encode(StoredSubmission(backend: backendURL, submission: pending))
        try data.write(to: outboxURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: outboxURL.path)
        outbox = pending
    }
    private func clearOutbox() {
        do {
            if FileManager.default.fileExists(atPath: outboxURL.path) { try FileManager.default.removeItem(at: outboxURL) }
            outbox = nil
        } catch { self.error = "未送信状態の保存に失敗しました。\(error.localizedDescription)" }
    }
}
