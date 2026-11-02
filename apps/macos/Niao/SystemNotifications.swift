import Foundation
import Combine
import UserNotifications

struct BackgroundResultNotification: Identifiable, Equatable {
    let id: String
    let sessionID: String
    let epoch: Int
    let sessionTitle: String
    let title: String
    let preview: String

    // Only committed background results produce OS notifications. History replay,
    // partial output and disappearing job snapshots are not completion events.
    static func from(_ event: ServerEvent, session: ChatSession) -> Self? {
        guard event.v == 2, event.type == "message_added", event.sessionId == session.id,
              event.epoch == session.epoch, let message = event.message, message.role == "assistant",
              let requestID = event.requestId, message.requestId == requestID else { return nil }
        let title: String
        if requestID.hasPrefix("notification:") { title = "記事取得の結果が届きました" }
        else if requestID.hasPrefix("reminder:") { title = "リマインダー" }
        else { return nil }
        let text = message.content.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let preview = String(text.prefix(120)) + (text.count > 120 ? "…" : "")
        return Self(id: session.id + ":" + message.id, sessionID: session.id, epoch: session.epoch,
                    sessionTitle: session.title, title: title, preview: preview)
    }
}

struct NotificationTarget: Equatable {
    let sessionID: String
    let epoch: Int
}

struct NotificationReceipt: Codable, Equatable {
    let id: String
    let eventID: String
    let sessionID: String
    let epoch: Int
    var unread: Bool
    var target: NotificationTarget { NotificationTarget(sessionID: sessionID, epoch: epoch) }
}

// Store only identifiers and read state, never credentials or message previews.
struct NotificationInbox: Codable {
    var version = 1
    let backend: String
    private(set) var receipts: [NotificationReceipt] = []
    private var unreadByConversation: [String: Int] = [:]
    var unreadCount: Int { unreadByConversation.values.reduce(0, +) }
    init(backend: String) { self.backend = backend }
    private enum CodingKeys: CodingKey { case version, backend, receipts, unreadByConversation }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        backend = try values.decode(String.self, forKey: .backend)
        receipts = try values.decode([NotificationReceipt].self, forKey: .receipts)
        unreadByConversation = try values.decodeIfPresent([String: Int].self, forKey: .unreadByConversation) ?? receipts.filter(\.unread).reduce(into: [:]) {
            $0[Self.key($1.target), default: 0] += 1
        }
    }
    private static func key(_ target: NotificationTarget) -> String { target.sessionID + ":" + String(target.epoch) }

    mutating func record(_ notice: BackgroundResultNotification, alreadyRead: Bool) -> NotificationReceipt? {
        guard !receipts.contains(where: { $0.eventID == notice.id }) else { return nil }
        let receipt = NotificationReceipt(id: "niao.result." + UUID().uuidString.lowercased(), eventID: notice.id,
                                          sessionID: notice.sessionID, epoch: notice.epoch, unread: !alreadyRead)
        receipts.append(receipt)
        if !alreadyRead { unreadByConversation[Self.key(receipt.target), default: 0] += 1 }
        return receipt
    }
    mutating func markRead(_ target: NotificationTarget) -> [String] {
        let ids = receipts.filter { $0.target == target && $0.unread }.map(\.id)
        for index in receipts.indices where receipts[index].target == target { receipts[index].unread = false }
        unreadByConversation.removeValue(forKey: Self.key(target))
        return ids
    }
    mutating func reconcile(_ sessions: [ChatSession]) -> [String] {
        let invalid = receipts.filter { receipt in
            !sessions.contains { $0.id == receipt.sessionID && $0.epoch == receipt.epoch }
        }.map(\.id)
        receipts.removeAll { invalid.contains($0.id) }
        let valid = Set(sessions.map { Self.key(NotificationTarget(sessionID: $0.id, epoch: $0.epoch)) })
        unreadByConversation = unreadByConversation.filter { valid.contains($0.key) }
        return invalid
    }
    mutating func trim() -> [String] {
        let excess = max(0, receipts.count - 512)
        let removed = receipts.prefix(excess).map(\.id)
        receipts.removeFirst(excess)
        return removed
    }
}

struct NotificationPermission: Equatable {
    enum Status { case unknown, notDetermined, denied, authorized }
    let status: Status
    let alerts: Bool
    let badges: Bool
    static let unknown = NotificationPermission(status: .unknown, alerts: false, badges: false)
}

@MainActor
protocol SystemNotificationDelivery: AnyObject {
    func permission() async -> NotificationPermission
    func requestAuthorization() async throws
    func post(id: String, notice: BackgroundResultNotification, badge: Int?) async throws
    func setBadge(_ count: Int) async throws
    func remove(ids: [String])
    func install(open: @escaping (String) -> Void, shouldPresent: @escaping (String) -> Bool)
}

@MainActor
final class AppleNotificationDelivery: NSObject, SystemNotificationDelivery, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    private var onOpen: ((String) -> Void)?
    private var canPresent: ((String) -> Bool)?
    func install(open: @escaping (String) -> Void, shouldPresent: @escaping (String) -> Bool) {
        onOpen = open; canPresent = shouldPresent; center.delegate = self
    }
    func permission() async -> NotificationPermission {
        let settings = await center.notificationSettings()
        let status: NotificationPermission.Status
        switch settings.authorizationStatus {
        case .notDetermined: status = .notDetermined
        case .denied: status = .denied
        case .authorized, .provisional, .ephemeral: status = .authorized
        @unknown default: status = .denied
        }
        return NotificationPermission(status: status, alerts: settings.alertSetting == .enabled, badges: settings.badgeSetting == .enabled)
    }
    func requestAuthorization() async throws {
        _ = try await center.requestAuthorization(options: [.alert, .badge])
    }
    func post(id: String, notice: BackgroundResultNotification, badge: Int?) async throws {
        let content = UNMutableNotificationContent()
        content.title = "Niao · " + notice.title
        content.subtitle = notice.sessionTitle
        content.body = notice.preview
        if let badge { content.badge = NSNumber(value: badge) }
        // nil means immediate delivery. No time/calendar trigger or APNs registration.
        try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }
    func setBadge(_ count: Int) async throws { try await center.setBadgeCount(count) }
    func remove(ids: [String]) {
        guard !ids.isEmpty else { return }
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let id = notification.request.identifier
        return await MainActor.run { canPresent?(id) == true ? [.banner, .list, .badge] : [] }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        let id = response.notification.request.identifier
        await MainActor.run { onOpen?(id) }
    }
}

@MainActor
final class SystemNotifications: ObservableObject {
    @Published private(set) var enabled: Bool
    @Published private(set) var permission = NotificationPermission.unknown
    @Published private(set) var requesting = false
    @Published private(set) var unreadCount = 0
    @Published private(set) var error: String?
    var onOpen: ((NotificationTarget) -> Void)?
    private let delivery: SystemNotificationDelivery
    private let defaults: UserDefaults
    private let storageURL: URL?
    private var writable = true
    private var inbox: NotificationInbox
    private var scope = UUID()
    private var operations: Task<Void, Never>?

    init(backend: String, storageURL: URL?, delivery: SystemNotificationDelivery? = nil, defaults: UserDefaults = .standard) {
        let delivery = delivery ?? AppleNotificationDelivery()
        self.delivery = delivery; self.defaults = defaults; self.storageURL = storageURL
        self.enabled = defaults.bool(forKey: "systemNotificationsEnabled")
        var restored = NotificationInbox(backend: backend)
        var discarded: [String] = []
        if let storageURL, FileManager.default.fileExists(atPath: storageURL.path) {
            do {
                let saved = try JSONDecoder().decode(NotificationInbox.self, from: Data(contentsOf: storageURL))
                guard saved.version == 1 else { throw CocoaError(.fileReadCorruptFile) }
                if saved.backend == backend { restored = saved; discarded = restored.trim() }
                else { discarded = saved.receipts.map(\.id) }
            } catch {
                writable = false
                self.error = "通知の未読状態を読み込めませんでした。既存ファイルを保護するため保存を停止しています。"
            }
        }
        inbox = restored; unreadCount = restored.unreadCount
        delivery.remove(ids: discarded)
        delivery.install(open: { [weak self] id in
            guard let self, let receipt = self.inbox.receipts.first(where: { $0.id == id }) else { return }
            self.onOpen?(receipt.target)
        }, shouldPresent: { [weak self] id in
            guard let self else { return false }
            return self.enabled && self.inbox.receipts.contains(where: { $0.id == id })
        })
    }
    var statusLabel: String {
        switch permission.status {
        case .unknown: "確認中"
        case .notDetermined: "未許可"
        case .denied: "システム設定で通知が拒否されています"
        case .authorized: "許可済み · 通知 \(permission.alerts ? "ON" : "OFF") / バッジ \(permission.badges ? "ON" : "OFF")"
        }
    }
    func refresh() {
        enqueue { [self] in
            let captured = scope
            let value = await delivery.permission()
            guard scope == captured else { return }
            permission = value
            await updateBadge()
        }
    }
    func setEnabled(_ value: Bool) {
        guard !requesting else { return }
        if !value {
            enabled = false; defaults.set(false, forKey: "systemNotificationsEnabled")
            let ids = inbox.receipts.map(\.id)
            enqueue { [self] in delivery.remove(ids: ids); try? await delivery.setBadge(0) }
            return
        }
        requesting = true
        enqueue { [self] in
            defer { requesting = false }
            do {
                let current = await delivery.permission()
                if current.status == .notDetermined { try await delivery.requestAuthorization() }
                permission = await delivery.permission()
                enabled = permission.status == .authorized
                defaults.set(enabled, forKey: "systemNotificationsEnabled")
                if !enabled { error = "通知を許可するには、システム設定のNiaoの通知設定を確認してください。" }
                else { error = nil }
                await updateBadge()
            } catch { self.error = "通知の許可を取得できませんでした。システムの通知設定を確認してください。" }
        }
    }
    func receive(_ notice: BackgroundResultNotification, alreadyRead: Bool) {
        guard let receipt = inbox.record(notice, alreadyRead: alreadyRead) else { return }
        let removed = inbox.trim(), captured = scope
        persist()
        enqueue { [self] in
            delivery.remove(ids: removed)
            guard scope == captured, enabled, inbox.receipts.contains(where: { $0.id == receipt.id }) else { return }
            let value = await delivery.permission()
            guard scope == captured, enabled, inbox.receipts.contains(where: { $0.id == receipt.id }) else { return }
            permission = value
            if value.status == .authorized && value.alerts {
                do {
                    // Badge state has one writer: setBadge(). A badge embedded in
                    // notification content could arrive late and undo a newer read.
                    try await delivery.post(id: receipt.id, notice: notice, badge: nil)
                    // A read, deletion, or backend change can occur while add() awaits.
                    if scope != captured || !enabled || !inbox.receipts.contains(where: { $0.id == receipt.id }) {
                        delivery.remove(ids: [receipt.id])
                    } else if inbox.receipts.first(where: { $0.id == receipt.id })?.unread == false && !alreadyRead {
                        delivery.remove(ids: [receipt.id])
                    }
                } catch { self.error = "OS通知を表示できませんでした。アプリ内の結果は会話履歴から確認できます。" }
            }
            await updateBadge()
        }
    }
    func markRead(_ target: NotificationTarget) {
        let previousCount = inbox.unreadCount
        let ids = inbox.markRead(target)
        guard !ids.isEmpty || previousCount != inbox.unreadCount else { return }
        persist()
        enqueue { [self] in delivery.remove(ids: ids); await updateBadge() }
    }
    func reconcile(_ sessions: [ChatSession]) {
        let previousCount = inbox.unreadCount
        let ids = inbox.reconcile(sessions)
        guard !ids.isEmpty || previousCount != inbox.unreadCount else { return }
        persist()
        enqueue { [self] in delivery.remove(ids: ids); await updateBadge() }
    }
    func changeBackend(_ backend: String) {
        guard backend != inbox.backend else { return }
        let ids = inbox.receipts.map(\.id)
        scope = UUID(); inbox = NotificationInbox(backend: backend); persist()
        enqueue { [self] in delivery.remove(ids: ids); await updateBadge() }
    }
    // Also useful for deterministic verification of asynchronous delivery ordering.
    func flush() async { await operations?.value }
    private func enqueue(_ operation: @escaping @MainActor () async -> Void) {
        let previous = operations
        operations = Task { await previous?.value; await operation() }
    }
    private func updateBadge() async {
        let captured = scope
        let value = await delivery.permission()
        guard scope == captured else { return }
        permission = value
        guard value.status == .authorized && value.badges else { return }
        do { try await delivery.setBadge(enabled ? inbox.unreadCount : 0) }
        catch { self.error = "アイコンのバッジを更新できませんでした。" }
    }
    private func persist() {
        unreadCount = inbox.unreadCount
        guard writable, let storageURL else { return }
        do {
            try JSONEncoder().encode(inbox).write(to: storageURL, options: [.atomic, .completeFileProtection])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: storageURL.path)
        } catch { self.error = "通知の未読状態を保存できませんでした。" }
    }
}
