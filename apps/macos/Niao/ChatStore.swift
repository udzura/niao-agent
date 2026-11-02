#if os(macOS)
import AppKit
#endif
import Combine
import Foundation

@MainActor
final class ChatStore: ObservableObject {
    @Published var toolToast = ToolCallToastState()
    let systemNotifications: SystemNotifications
    var revealChatWindow: (() -> Void)?
    private var pendingNotificationTarget: NotificationTarget?
    private var conversationPresented = false
    private var conversationCovered = false
    private var appActive = false
    private var viewingConversation: Bool {
        guard conversationPresented, !conversationCovered, appActive else { return false }
        #if os(macOS)
        return NSApplication.shared.isActive && NSApplication.shared.keyWindow?.title == "Niao"
        #else
        return true
        #endif
    }
    @Published var toolStatistics = ToolStatistics()
    @Published var toolStatisticsError: String?
    private(set) var toolSessionID = UUID()
    private var toolStatisticsURL: URL?
    private var statisticsWritable = true
    @Published var agentSettings: AgentSettings?
    @Published var controlBusy = false
    @Published var backgroundJobs: BackgroundJobsSnapshot?
    @Published var runningToolName: String?
    @Published var sessionCatalog: SessionCatalog?
    @Published var selectedSessionID: String?
    @Published var unreadSessions: Set<String> = []
    @Published var hasOlderMessages = false
    @Published var historyLoading = false
    private var oldestCursor: Int?
    private var selectionRevision = 0
    private var drafts: [String: String] = [:]
    private var lastRead: [String: String] = [:]
    private var outboxes: [String: Submission] = [:]
    var selectedSession: ChatSession? { sessionCatalog?.items.first { $0.id == selectedSessionID } }
    var agentBusy: Bool { sessionCatalog?.activeSessionId != nil || busy }
    private var historyEpoch: Int?
    @Published var messages: [ChatMessage] = []
    @Published var usage: UsageSnapshot?
    @Published var usageError: String?
    @Published var usageLoading = false
    private var usageTask: Task<Void, Never>?
    @Published var platformUsage: PlatformUsageSnapshot?
    @Published var platformUsageError: String?
    @Published var platformUsageLoading = false
    private var platformUsageTask: Task<Void, Never>?
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
    private var authenticationBlocked = false
    private var retryAttempt = 0
    private var eventRevision = 0
    private var settingsRevision = 0
    private let outboxURL: URL

    init() {
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Niao")
        outboxURL = folder.appendingPathComponent("outbox.json")
        let initialBackend = UserDefaults.standard.string(forKey: "backendURL") ?? "http://127.0.0.1:8787"
        systemNotifications = SystemNotifications(backend: initialBackend, storageURL: folder.appendingPathComponent("notification-inbox.json"))
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            toolStatisticsURL = folder.appendingPathComponent("tool-statistics.json")
            do { toolStatistics = try ToolStatistics.load(from: toolStatisticsURL!) }
            catch {
                statisticsWritable = false
                toolStatisticsError = "統計ファイルを読み込めませんでした。既存ファイルを保護するため保存を停止しています。"
            }
            if let data = try? Data(contentsOf: outboxURL) {
                if let stored = try? JSONDecoder().decode(StoredOutboxes.self, from: data) {
                    if stored.backend == backendURL { outboxes = stored.submissions }
                } else {
                    let stored = try JSONDecoder().decode(StoredSubmission.self, from: data)
                    if stored.backend == backendURL {
                        var pending = stored.submission
                        pending.v = 2; pending.sessionId = "legacy"
                        outboxes["legacy"] = pending
                    }
                }

            }
        } catch { self.error = "未送信メッセージの復元に失敗しました。\(error.localizedDescription)" }
        lastRead = UserDefaults.standard.dictionary(forKey: "sessionLastRead." + backendURL) as? [String: String] ?? [:]
        systemNotifications.onOpen = { [weak self] target in self?.openSystemNotification(target) }
        toolSessionID = toolStatistics.beginSession()
        saveToolStatistics()
        #if os(macOS)
        NotificationCenter.default.addObserver(self, selector: #selector(wake), name: NSApplication.didBecomeActiveNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(wake), name: NSWorkspace.didWakeNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(sleep), name: NSWorkspace.willSleepNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(sleep), name: NSWorkspace.screensDidSleepNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(sleep), name: NSWorkspace.sessionDidResignActiveNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(wake), name: NSWorkspace.screensDidWakeNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(wake), name: NSWorkspace.sessionDidBecomeActiveNotification, object: nil)
        #endif
    }
    var busy: Bool { partial != nil || turns.contains { $0.status == "running" } }
    var canSend: Bool { connected && !controlBusy && !agentBusy && !historyLoading && selectedSessionID != nil && outbox == nil && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.utf16.count <= 8000 }

    func saveSettings(url: String, token: String) async throws {
        let valid = try BackendURL.validate(url).absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let secret = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard secret.count >= 32, !secret.contains("\n"), !secret.contains("\r") else { throw NiaoError.configuration }
        // Keep an uncertain send tied to its original server rather than sending it elsewhere.
        if valid != backendURL && !outboxes.isEmpty {
            throw NSError(domain: "Niao", code: 1, userInfo: [NSLocalizedDescriptionKey: "未送信メッセージを再送するか破棄してから接続先を変更してください。"])
        }
        try await Keychain.save(secret, backend: valid)
        try Task.checkCancellation()
        systemNotifications.changeBackend(valid)
        pendingNotificationTarget = nil
        backendURL = valid
        UserDefaults.standard.set(valid, forKey: "backendURL")
        messages = []; cursor = 0; turns = []; partial = nil
        historyEpoch = nil; agentSettings = nil; backgroundJobs = nil
        sessionCatalog = nil; selectedSessionID = nil; drafts = [:]; unreadSessions = []; lastRead = UserDefaults.standard.dictionary(forKey: "sessionLastRead." + valid) as? [String: String] ?? [:]
        toolToast.clear()
        usage = nil; usageError = nil; usageRefreshAt = nil
        platformUsage = nil; platformUsageError = nil
        reconnect()
    }
    func start() { systemNotifications.refresh(); if loop == nil { reconnect() } }
    func resume() { if !connected && loop == nil && !authenticationBlocked { reconnect() } }
    func suspend() { appActive = false; Keychain.lock(); disconnect(); connection = "ロック中" }
    #if os(macOS)
    @objc private func wake() { conversationActivityChanged(true); resume() }
    @objc private func sleep() { suspend() }
    #endif
    private func disconnect() {
        generation = UUID()
        controlBusy = false
        runningToolName = nil
        usageTask?.cancel(); usageTask = nil; usageLoading = false
        platformUsageTask?.cancel(); platformUsageTask = nil; platformUsageLoading = false
        backend = nil
        loop?.cancel(); loop = nil
        heartbeat?.cancel(); heartbeat = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        connected = false
        partial = nil
    }
    func reconnect() {
        authenticationBlocked = false
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
                let token = try await Keychain.read(backend: backendURL)
                guard generation == id, !Task.isCancelled else { return }
                guard token.count >= 32 else { throw NiaoError.configuration }
                let backend = Backend(baseURL: base, token: token)
                self.backend = backend
                let catalogue = try await backend.sessions()
                guard generation == id, !Task.isCancelled else { return }
                sessionCatalog = nil
                acceptCatalog(catalogue.sessions)
                acceptJobs(catalogue.jobs)
                if selectedSessionID == nil {
                    let saved = UserDefaults.standard.string(forKey: "selectedSession." + backendURL)
                    selectLocal(catalogue.sessions.items.first(where: { $0.id == saved })?.id ?? catalogue.sessions.items.first?.id)
                }
                // Auth check before the upgrade gives a useful 401 message to the UI.
                try await synchronize(backend, id: id)
                let ws = backend.socket()
                socket = ws
                let ready = try await Backend.event(from: ws)
                guard ready.type == "ready", ready.v == 2 else { throw NiaoError.protocolMismatch }
                // Subscribe before the final sync: events during HTTP are queued by URLSession.
                try await synchronize(backend, id: id)
                guard generation == id, !Task.isCancelled else { return }
                connected = true; connection = "接続済み"; error = nil; retryAttempt = 0
                applyPendingNotification()
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
                connected = false; partial = nil; runningToolName = nil; connection = "未接続"
                self.error = error.localizedDescription
                heartbeat?.cancel(); heartbeat = nil
                socket?.cancel(with: .goingAway, reason: nil); socket = nil
                if case NiaoError.unauthorized = error { return }
                if case NiaoError.configuration = error { return }
                if case NiaoError.authentication = error { authenticationBlocked = true; return }
                if case NiaoError.keychain = error { authenticationBlocked = true; return }
                retryAttempt += 1
                let delay = min(pow(2.0, Double(min(retryAttempt, 5))), 30) + Double.random(in: 0...1)
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            }
        }
    }
    private func synchronize(_ backend: Backend, id: UUID) async throws {
        guard let sessionID = selectedSessionID else { return }
        let selection = selectionRevision
        var more = true
        while more {
            let revision = eventRevision
            let settingsVersion = settingsRevision
            let page = try await backend.history(after: cursor, epoch: historyEpoch, sessionID: sessionID, latest: cursor == 0)
            guard generation == id, selectionRevision == selection, selectedSessionID == sessionID, !Task.isCancelled else { return }
            guard acceptEpoch(page.epoch ?? 0) else { continue }
            if let catalogue = page.sessions { acceptCatalog(catalogue) }
            if page.hasOlder == true { hasOlderMessages = true }
            if oldestCursor == nil { oldestCursor = page.beforeCursor ?? page.messages.first?.seq }
            if let jobs = page.jobs { acceptJobs(jobs) } else { backgroundJobs = nil }
            messages = mergeMessages(messages, page.messages)
            cursor = page.cursor
            // A response started before a socket event must not roll back its status.
            if eventRevision == revision {
                turns = page.turns
                partial = page.active
            }
            if settingsRevision == settingsVersion { agentSettings = page.settings }
            more = page.hasMore
        }
        if let pending = outbox, messages.contains(where: { $0.requestId == pending.requestId }) { clearOutbox() }
        if let session = selectedSession {
            lastRead[session.id] = session.lastActivityAt
            UserDefaults.standard.set(lastRead, forKey: "sessionLastRead." + backendURL)
        }
        if viewingConversation, let session = selectedSession {
            systemNotifications.markRead(NotificationTarget(sessionID: session.id, epoch: session.epoch))
        }
    }
    private func handle(_ event: ServerEvent) {
        guard event.v == 2 else { return }
        if let catalogue = event.sessions { acceptCatalog(catalogue) }
        acceptJobs(event.jobs)
        if event.type == "settings_updated" {
            settingsRevision += 1; agentSettings = event.settings; return
        }
        if event.type == "session_deleted" {
            if let id = event.sessionId {
                drafts.removeValue(forKey: id); outboxes.removeValue(forKey: id); unreadSessions.remove(id)
                saveOutboxes()
                if selectedSessionID == id { selectLocal(nil); chooseAvailableSession() }
            }
            return
        }
        if event.type == "message_added", let session = sessionCatalog?.items.first(where: { $0.id == event.sessionId }) {
            if let notice = BackgroundResultNotification.from(event, session: session) {
                let alreadyRead = viewingConversation && selectedSessionID == session.id
                systemNotifications.receive(notice, alreadyRead: alreadyRead)
            }
        }
        if event.type == "tool_status" {
            if let requestID = event.requestId, let name = event.name, let status = event.status {
                let newCall = toolStatistics.observe(sessionID: toolSessionID, backend: backendURL, epoch: event.epoch ?? 0,
                                       requestID: requestID, name: name, status: status)
                if newCall && event.sessionId == selectedSessionID { toolToast.show(name: name) }
                saveToolStatistics()
            }
        }
        if let target = event.sessionId, target != selectedSessionID {
            if ["committed", "message_added"].contains(event.type) { unreadSessions.insert(target) }
            if ["accepted", "committed", "error"].contains(event.type), outboxes[target]?.requestId == event.requestId, event.type != "error" {
                outboxes.removeValue(forKey: target); saveOutboxes()
            }
            return
        }
        guard event.sessionId != nil else { return }
        guard acceptEpoch(event.epoch ?? 0) else { return }
        eventRevision += 1
        acceptJobs(event.jobs)
        switch event.type {
        case "tool_status":
            if event.status == "running" {
                runningToolName = event.name?.isEmpty == false ? event.name : "ツール"
            } else if event.status == "completed", event.name == nil || event.name == runningToolName {
                runningToolName = nil
            }

        case "history_cleared": break // acceptEpoch already reset the local conversation.
        case "settings_updated":
            settingsRevision += 1
            agentSettings = event.settings
        case "accepted":
            if let message = event.message {
                messages = mergeMessages(messages, [message])
                turns.removeAll { $0.requestId == message.requestId }
                turns.append(Turn(requestId: message.requestId, status: "running", errorCode: nil))
                if outbox?.requestId == message.requestId { clearOutbox() }
            }
        case "partial":
            if let requestID = event.requestId { partial = PartialMessage(requestId: requestID, text: event.text ?? "", thinking: event.thinking) }
        case "committed":
            runningToolName = nil
            finishToolTurn(event)
            messages = mergeMessages(messages, event.messages ?? [])
            turns.removeAll { $0.requestId == event.requestId }
            if partial?.requestId == event.requestId { partial = nil }
            if outbox?.requestId == event.requestId { clearOutbox() }
            refreshUsage()
        case "message_added":
            // Background follow-ups have no user submission/outbox to complete.
            if let message = event.message { messages = mergeMessages(messages, [message]) }
            if partial?.requestId == event.requestId { partial = nil }
            refreshUsage()
        case "notification_deferred":
            if partial?.requestId == event.requestId { partial = nil }
            if let details = event.details { error = explanation(event.code ?? "ai_unavailable", details: details) }
            refreshUsage()
        case "error":
            runningToolName = nil
            finishToolTurn(event)
            refreshUsage()
            error = explanation(event.code ?? "unknown", details: event.details)
            if let requestID = event.requestId {
                turns.removeAll { $0.requestId == requestID }
                if messages.contains(where: { $0.requestId == requestID && $0.role == "user" }) {
                    turns.append(Turn(requestId: requestID, status: "failed", errorCode: event.code, errorDetails: event.details))
                }
                if partial?.requestId == requestID { partial = nil }
            }
        default: break
        }
    }
    private func acceptJobs(_ snapshot: BackgroundJobsSnapshot?) {
        guard let snapshot else { return }
        backgroundJobs = backgroundJobs?.accepting(snapshot) ?? snapshot
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
    private func acceptCatalog(_ incoming: SessionCatalog) {
        let previous = sessionCatalog
        let accepted = previous?.accepting(incoming) ?? incoming
        sessionCatalog = accepted
        systemNotifications.reconcile(accepted.items)
        for session in accepted.items where session.id != selectedSessionID && (session.messageCount ?? 0) > 0 {
            if session.lastActivityAt > (lastRead[session.id] ?? "") { unreadSessions.insert(session.id) }
        }
        let validIDs = Set(accepted.items.map(\.id))
        unreadSessions = unreadSessions.intersection(validIDs)
        let remaining = outboxes.filter { validIDs.contains($0.key) }
        if remaining.count != outboxes.count { outboxes = remaining; saveOutboxes() }
        drafts = drafts.filter { validIDs.contains($0.key) }
        guard previous != accepted else { return }
        if let current = selectedSessionID, !accepted.items.contains(where: { $0.id == current }) {
            selectLocal(nil)
            drafts.removeValue(forKey: current); outboxes.removeValue(forKey: current); saveOutboxes()
            chooseAvailableSession()
        }
    }
    private func selectLocal(_ id: String?) {
        guard id != selectedSessionID else { return }
        if let previous = selectedSessionID { drafts[previous] = draft }
        selectionRevision += 1
        selectedSessionID = id
        UserDefaults.standard.set(id, forKey: "selectedSession." + backendURL)
        messages = []; turns = []; partial = nil; cursor = 0; oldestCursor = nil
        historyEpoch = nil; runningToolName = nil; toolToast.clear(); hasOlderMessages = false
        draft = id.flatMap { drafts[$0] } ?? ""
        outbox = id.flatMap { outboxes[$0] }
        if let id {
            unreadSessions.remove(id)
            lastRead[id] = sessionCatalog?.items.first(where: { $0.id == id })?.lastActivityAt
            UserDefaults.standard.set(lastRead, forKey: "sessionLastRead." + backendURL)
        }
    }
    private func chooseAvailableSession() {
        let items = sessionCatalog?.items ?? []
        selectLocal(items.first(where: { $0.archivedAt == nil })?.id ?? items.first?.id)
        loadSelectedHistory()
    }
    func selectSession(_ id: String) {
        guard sessionCatalog?.items.contains(where: { $0.id == id }) == true else { return }
        selectLocal(id)
        loadSelectedHistory()
    }
    func conversationAppeared(active: Bool) {
        conversationPresented = true
        conversationActivityChanged(active)
    }
    func conversationDisappeared() { conversationPresented = false }
    func conversationCoverChanged(_ covered: Bool) {
        conversationCovered = covered
        if !covered { markVisibleNotificationsRead() }
    }
    func conversationActivityChanged(_ active: Bool) {
        appActive = active
        if active { systemNotifications.refresh(); markVisibleNotificationsRead() }
    }
    private func markVisibleNotificationsRead() {
        guard viewingConversation, !historyLoading, let session = selectedSession else { return }
        systemNotifications.markRead(NotificationTarget(sessionID: session.id, epoch: session.epoch))
    }
    private func openSystemNotification(_ target: NotificationTarget) {
        pendingNotificationTarget = target
        revealChatWindow?()
        #if os(macOS)
        NSApplication.shared.activate(ignoringOtherApps: true)
        #endif
        applyPendingNotification()
    }
    private func applyPendingNotification() {
        guard connected, let catalog = sessionCatalog, let target = pendingNotificationTarget else { return }
        pendingNotificationTarget = nil
        guard catalog.items.contains(where: { $0.id == target.sessionID && $0.epoch == target.epoch }) else {
            error = explanation("session_not_found"); return
        }
        selectSession(target.sessionID)
    }
    private func loadSelectedHistory() {
        guard let backend, selectedSessionID != nil else { historyLoading = false; return }
        let id = generation, selection = selectionRevision
        historyLoading = true
        Task {
            defer { if generation == id && selectionRevision == selection { historyLoading = false } }
            do { try await synchronize(backend, id: id) }
            catch {
                guard generation == id, selectionRevision == selection else { return }
                self.error = error.localizedDescription
                if case NiaoError.http(404) = error { reconnect() }
            }
        }
    }
    func createSession() {
        guard connected, !controlBusy, let backend else { return }
        controlBusy = true; let id = generation
        Task {
            defer { if generation == id { controlBusy = false } }
            do {
                let result = try await backend.createSession()
                guard generation == id else { return }
                acceptCatalog(result.sessions)
                if let session = result.session { selectSession(session.id) }
            } catch { if generation == id { self.error = error.localizedDescription; reconnect() } }
        }
    }
    func editSession(_ session: ChatSession, title: String? = nil, archived: Bool? = nil) {
        guard connected, !controlBusy, let backend else { return }
        controlBusy = true; let id = generation
        Task {
            defer { if generation == id { controlBusy = false } }
            do {
                let result = try await backend.editSession(session.id, title: title, archived: archived)
                guard generation == id else { return }
                acceptCatalog(result.sessions)
            } catch { if generation == id { self.error = error.localizedDescription; reconnect() } }
        }
    }
    func deleteSession(_ session: ChatSession) {
        guard connected, !controlBusy, sessionCatalog?.activeSessionId != session.id, let backend else { return }
        controlBusy = true; let id = generation
        Task {
            defer { if generation == id { controlBusy = false } }
            do {
                try await backend.deleteSession(session)
                let result = try await backend.sessions()
                guard generation == id else { return }
                acceptCatalog(result.sessions); acceptJobs(result.jobs)
            } catch { if generation == id { self.error = error.localizedDescription; reconnect() } }
        }
    }
    func loadOlderMessages() {
        guard let backend, let session = selectedSessionID, let before = oldestCursor, hasOlderMessages, !historyLoading else { return }
        let id = generation, selection = selectionRevision
        historyLoading = true
        Task {
            defer { if generation == id && selectionRevision == selection { historyLoading = false } }
            do {
                let page = try await backend.history(after: 0, epoch: historyEpoch, sessionID: session, before: before)
                guard generation == id, selectionRevision == selection, selectedSessionID == page.sessionId else { return }
                guard acceptEpoch(page.epoch ?? 0) else { return }
                messages = mergeMessages(messages, page.messages)
                oldestCursor = page.beforeCursor
                hasOlderMessages = page.hasOlder == true
            } catch { if generation == id && selectionRevision == selection { self.error = error.localizedDescription } }
        }
    }

    @discardableResult
    private func acceptEpoch(_ incoming: Int) -> Bool {
        if let current = historyEpoch, incoming < current { return false }
        if let current = historyEpoch, incoming > current {
            messages = []; turns = []; partial = nil; cursor = 0; draft = ""; oldestCursor = nil; hasOlderMessages = false
            runningToolName = nil
            toolToast.clear()
        }
        historyEpoch = incoming
        if let pending = outbox, (pending.epoch ?? 0) != incoming { clearOutbox() }
        return true
    }
    func updateModelSettings(_ modelId: String) {
        updateAgentSettings(ModelSettingsUpdate(modelId: modelId))
    }
    func updateThinking(_ choice: ThinkingChoice) {
        guard let settings = agentSettings, choice != .custom else { return }
        updateAgentSettings(choice.update(using: settings.thinkingPolicy))
    }
    private func updateAgentSettings(_ update: ModelSettingsUpdate) {
        guard connected, !controlBusy, let backend else { return }
        controlBusy = true
        let id = generation
        let revision = settingsRevision
        Task {
            defer { if generation == id { controlBusy = false } }
            do {
                let settings = try await backend.updateModelSettings(update)
                guard generation == id else { return }
                if settingsRevision == revision { agentSettings = settings }
                error = nil
            } catch {
                guard generation == id else { return }
                self.error = error.localizedDescription
                // A lost response may still have saved the selection. Sync before sending.
                reconnect()
            }
        }
    }
    func clearHistory() {
        guard connected, !busy, !controlBusy, let backend, let epoch = historyEpoch, let sessionID = selectedSessionID else { return }
        controlBusy = true
        let id = generation
        Task {
            defer { if generation == id { controlBusy = false } }
            do {
                let result = try await backend.clearHistory(epoch: epoch, sessionID: sessionID)
                guard generation == id else { return }
                if selectedSessionID == sessionID { acceptEpoch(result.epoch) }
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
    func refreshPlatformUsage() {
        guard platformUsageTask == nil, let backend else { return }
        let id = generation
        platformUsageLoading = true
        platformUsageTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if generation == id { platformUsageTask = nil; platformUsageLoading = false }
            }
            do {
                let snapshot = try await backend.platformUsage()
                guard generation == id, !Task.isCancelled else { return }
                platformUsage = snapshot; platformUsageError = nil
            } catch {
                guard generation == id, !Task.isCancelled else { return }
                if case NiaoError.http(404) = error {
                    platformUsageError = "Workers統計に対応したバックエンドをデプロイしてください。"
                } else { platformUsageError = "Workersの使用量を更新できませんでした。" }
            }
        }
    }
    func send() {
        guard canSend else { return }
        var pending = Submission(requestId: UUID().uuidString.lowercased(), content: draft.trimmingCharacters(in: .whitespacesAndNewlines), epoch: historyEpoch)
        pending.v = 2; pending.sessionId = selectedSessionID
        do { try persistOutbox(pending); draft = ""; sendPending(pending) }
        catch { self.error = error.localizedDescription }
    }
    func retry(_ message: ChatMessage) {
        guard connected, !controlBusy, !agentBusy, !historyLoading, outbox == nil else { return }
        var pending = Submission(requestId: message.requestId, content: message.content, epoch: historyEpoch)
        pending.v = 2; pending.sessionId = selectedSessionID
        do { try persistOutbox(pending); sendPending(pending) }
        catch { self.error = error.localizedDescription }
    }
    func resendOutbox() { if let pending = outbox, connected, !controlBusy, !agentBusy, !historyLoading { sendPending(pending) } }
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
        guard let sessionID = pending.sessionId else { throw NiaoError.protocolMismatch }
        var next = outboxes; next[sessionID] = pending
        let stored = StoredOutboxes(backend: backendURL, submissions: next)
        try JSONEncoder().encode(stored).write(to: outboxURL, options: [.atomic, .completeFileProtection])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: outboxURL.path)
        outboxes = next; outbox = pending
    }
    private func saveOutboxes() {
        do {
            try JSONEncoder().encode(StoredOutboxes(backend: backendURL, submissions: outboxes))
                .write(to: outboxURL, options: [.atomic, .completeFileProtection])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: outboxURL.path)
        } catch { self.error = "未送信状態の保存に失敗しました。\(error.localizedDescription)" }
    }
    private func clearOutbox() {
        if let id = selectedSessionID { outboxes.removeValue(forKey: id) }
        outbox = nil; saveOutboxes()
    }
}
