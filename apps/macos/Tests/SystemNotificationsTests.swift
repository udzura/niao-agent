import XCTest
@testable import NiaoCore

@MainActor
private final class FakeNotificationDelivery: SystemNotificationDelivery {
    var permissions = NotificationPermission(status: .authorized, alerts: true, badges: true)
    var requests = 0
    var requestAllowed = true
    var failPost = false
    var failBadge = false
    var posts: [(id: String, notice: BackgroundResultNotification, badge: Int?)] = []
    var badges: [Int] = []
    var removed: [String] = []
    var opened: ((String) -> Void)?
    var shouldPresent: ((String) -> Bool)?
    var blockPost = false
    var releasePost: CheckedContinuation<Void, Never>?
    func permission() async -> NotificationPermission { permissions }
    func requestAuthorization() async throws {
        requests += 1
        permissions = NotificationPermission(status: requestAllowed ? .authorized : .denied, alerts: requestAllowed, badges: requestAllowed)
    }
    func post(id: String, notice: BackgroundResultNotification, badge: Int?) async throws {
        if failPost { throw CocoaError(.fileWriteUnknown) }
        posts.append((id, notice, badge))
        if blockPost { await withCheckedContinuation { releasePost = $0 } }
    }
    func setBadge(_ count: Int) async throws {
        if failBadge { throw CocoaError(.fileWriteUnknown) }
        badges.append(count)
    }
    func remove(ids: [String]) { removed += ids }
    func install(open: @escaping (String) -> Void, shouldPresent: @escaping (String) -> Bool) {
        opened = open; self.shouldPresent = shouldPresent
    }
}

@MainActor
final class SystemNotificationsTests: XCTestCase {
    private func notice(_ id: String = "event-a", session: String = "a", epoch: Int = 0) -> BackgroundResultNotification {
        BackgroundResultNotification(id: id, sessionID: session, epoch: epoch, sessionTitle: "会話", title: "結果が届きました", preview: "private-preview-秘密の本文")
    }
    private func session(_ id: String = "a", epoch: Int = 0) -> ChatSession {
        ChatSession(id: id, title: "会話", createdAt: "", updatedAt: "", lastActivityAt: "", archivedAt: nil, epoch: epoch, messageCount: 0)
    }
    private func setup(enabled: Bool = true, storage: URL? = nil) -> (SystemNotifications, FakeNotificationDelivery, UserDefaults, String) {
        let suite = "NiaoNotificationTests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.set(enabled, forKey: "systemNotificationsEnabled")
        let fake = FakeNotificationDelivery()
        return (SystemNotifications(backend: "https://example.org", storageURL: storage, delivery: fake, defaults: defaults), fake, defaults, suite)
    }
    func testReceiptsTrackUnreadAndPersistNoMessageContent() throws {
        var inbox = NotificationInbox(backend: "https://example.org")
        let first = try XCTUnwrap(inbox.record(notice(), alreadyRead: false))
        XCTAssertNil(inbox.record(notice(), alreadyRead: false))
        _ = inbox.record(notice("event-b", session: "b"), alreadyRead: true)
        XCTAssertEqual(inbox.unreadCount, 1)
        let json = try JSONEncoder().encode(inbox)
        XCTAssertFalse(String(decoding: json, as: UTF8.self).contains("private-preview"))
        var restored = try JSONDecoder().decode(NotificationInbox.self, from: json)
        XCTAssertEqual(restored.markRead(first.target), [first.id])
        XCTAssertEqual(restored.unreadCount, 0)
        XCTAssertNil(restored.record(notice(), alreadyRead: false), "Reading must retain deduplication metadata")
    }
    func testPostsOnceAndClearsUnreadBadgeWhenEachConversationIsOpened() async {
        let (controller, fake, defaults, suite) = setup()
        defer { defaults.removePersistentDomain(forName: suite) }
        controller.receive(notice(), alreadyRead: false)
        controller.receive(notice("event-b", session: "b"), alreadyRead: false)
        controller.receive(notice(), alreadyRead: false)
        await controller.flush()
        XCTAssertEqual(fake.posts.count, 2)
        XCTAssertTrue(fake.posts.allSatisfy { $0.badge == nil }, "Delayed OS delivery must not replay old badge counts")
        XCTAssertEqual(fake.badges.last, 2)
        XCTAssertEqual(controller.unreadCount, 2)
        XCTAssertEqual(fake.shouldPresent?(fake.posts[0].id), true)
        controller.markRead(NotificationTarget(sessionID: "a", epoch: 0))
        await controller.flush()
        XCTAssertEqual(fake.badges.last, 1)
        XCTAssertTrue(fake.removed.contains(fake.posts[0].id))
        controller.markRead(NotificationTarget(sessionID: "b", epoch: 0))
        await controller.flush()
        XCTAssertEqual(fake.badges.last, 0)
    }
    func testVisibleConversationStillNotifiesButDoesNotIncrementUnread() async {
        let (controller, fake, defaults, suite) = setup()
        defer { defaults.removePersistentDomain(forName: suite) }
        controller.receive(notice(), alreadyRead: true)
        await controller.flush()
        XCTAssertEqual(fake.posts.count, 1)
        XCTAssertNil(fake.posts.first?.badge)
        XCTAssertEqual(controller.unreadCount, 0)
    }
    func testPermissionIsOnlyRequestedByExplicitEnablingAndHistoryIsNotReposted() async {
        let (controller, fake, defaults, suite) = setup(enabled: false)
        defer { defaults.removePersistentDomain(forName: suite) }
        fake.permissions = NotificationPermission(status: .notDetermined, alerts: false, badges: false)
        controller.refresh()
        controller.receive(notice(), alreadyRead: false)
        await controller.flush()
        XCTAssertEqual(fake.requests, 0)
        XCTAssertTrue(fake.posts.isEmpty)
        controller.setEnabled(true)
        await controller.flush()
        XCTAssertEqual(fake.requests, 1)
        XCTAssertTrue(controller.enabled)
        XCTAssertTrue(fake.posts.isEmpty, "Enabling should not replay old notifications")
        XCTAssertEqual(fake.badges.last, 1)
        controller.receive(notice("event-new"), alreadyRead: false)
        await controller.flush()
        XCTAssertEqual(fake.posts.count, 1)
    }
    func testDeniedPermissionDoesNotPostOrInterruptReceiptTracking() async {
        let (controller, fake, defaults, suite) = setup(enabled: false)
        defer { defaults.removePersistentDomain(forName: suite) }
        fake.permissions = NotificationPermission(status: .notDetermined, alerts: false, badges: false)
        fake.requestAllowed = false
        controller.setEnabled(true)
        await controller.flush()
        controller.receive(notice(), alreadyRead: false)
        await controller.flush()
        XCTAssertFalse(controller.enabled)
        XCTAssertEqual(controller.unreadCount, 1)
        XCTAssertTrue(fake.posts.isEmpty)
        XCTAssertNotNil(controller.error)
    }
    func testAlertAndBadgePermissionsAreIndependent() async {
        let (controller, fake, defaults, suite) = setup()
        defer { defaults.removePersistentDomain(forName: suite) }
        fake.permissions = NotificationPermission(status: .authorized, alerts: false, badges: true)
        controller.receive(notice(), alreadyRead: false)
        await controller.flush()
        XCTAssertTrue(fake.posts.isEmpty)
        XCTAssertEqual(fake.badges.last, 1)
        fake.permissions = NotificationPermission(status: .authorized, alerts: true, badges: false)
        controller.receive(notice("event-b"), alreadyRead: false)
        await controller.flush()
        XCTAssertEqual(fake.posts.count, 1)
        XCTAssertNil(fake.posts.first?.badge)
        XCTAssertEqual(fake.badges.count, 1)
    }
    func testDeletionDuringInFlightDeliveryCannotLeaveAnOldNotificationOrBadge() async throws {
        let (controller, fake, defaults, suite) = setup()
        defer { defaults.removePersistentDomain(forName: suite) }
        fake.blockPost = true
        controller.receive(notice(), alreadyRead: false)
        for _ in 0..<100 where fake.releasePost == nil { await Task.yield() }
        let release = try XCTUnwrap(fake.releasePost)
        controller.reconcile([])
        release.resume()
        await controller.flush()
        XCTAssertEqual(controller.unreadCount, 0)
        XCTAssertTrue(fake.removed.contains(try XCTUnwrap(fake.posts.first).id))
        XCTAssertEqual(fake.badges.last, 0)
        XCTAssertEqual(fake.shouldPresent?(fake.posts[0].id), false)
    }
    func testReadingDuringInFlightDeliveryKeepsTheBadgeCleared() async throws {
        let (controller, fake, defaults, suite) = setup()
        defer { defaults.removePersistentDomain(forName: suite) }
        fake.blockPost = true
        controller.receive(notice(), alreadyRead: false)
        for _ in 0..<100 where fake.releasePost == nil { await Task.yield() }
        let release = try XCTUnwrap(fake.releasePost)
        controller.markRead(NotificationTarget(sessionID: "a", epoch: 0))
        release.resume()
        await controller.flush()
        XCTAssertEqual(controller.unreadCount, 0)
        XCTAssertEqual(fake.badges.last, 0)
        XCTAssertNil(fake.posts.first?.badge)
        XCTAssertTrue(fake.removed.contains(try XCTUnwrap(fake.posts.first).id))
    }
    func testBackendChangeDiscardsInFlightOldTargetsAndSerializesBadgeUpdates() async throws {
        let (controller, fake, defaults, suite) = setup()
        defer { defaults.removePersistentDomain(forName: suite) }
        fake.blockPost = true
        controller.receive(notice(), alreadyRead: false)
        for _ in 0..<100 where fake.releasePost == nil { await Task.yield() }
        let release = try XCTUnwrap(fake.releasePost)
        controller.changeBackend("https://different.example.org")
        fake.blockPost = false
        controller.receive(notice("new", session: "b"), alreadyRead: false)
        release.resume()
        await controller.flush()
        var target: NotificationTarget?
        controller.onOpen = { target = $0 }
        fake.opened?(fake.posts[0].id)
        XCTAssertNil(target)
        fake.opened?(try XCTUnwrap(fake.posts.last).id)
        XCTAssertEqual(target, NotificationTarget(sessionID: "b", epoch: 0))
        XCTAssertEqual(fake.badges.last, 1)
        XCTAssertTrue(fake.removed.contains(fake.posts[0].id))
    }
    func testDisableAndHistoryClearRemoveDeliveredNotifications() async {
        let (controller, fake, defaults, suite) = setup()
        defer { defaults.removePersistentDomain(forName: suite) }
        controller.receive(notice(), alreadyRead: false)
        await controller.flush()
        controller.reconcile([session(epoch: 1)])
        await controller.flush()
        XCTAssertEqual(controller.unreadCount, 0)
        XCTAssertEqual(fake.badges.last, 0)
        controller.receive(notice("new", epoch: 1), alreadyRead: false)
        await controller.flush()
        controller.setEnabled(false)
        await controller.flush()
        XCTAssertFalse(controller.enabled)
        XCTAssertEqual(fake.badges.last, 0)
        XCTAssertTrue(fake.posts.allSatisfy { fake.removed.contains($0.id) })
    }
    func testRestartsRestoreBadgeAndTapTargetWithoutRepostingContent() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("inbox.json")
        let (first, _, defaults, suite) = setup(storage: url)
        defer { defaults.removePersistentDomain(forName: suite) }
        first.receive(notice(), alreadyRead: false)
        await first.flush()
        let fake = FakeNotificationDelivery()
        let restored = SystemNotifications(backend: "https://example.org", storageURL: url, delivery: fake, defaults: defaults)
        restored.refresh()
        restored.receive(notice(), alreadyRead: false)
        await restored.flush()
        XCTAssertEqual(restored.unreadCount, 1)
        XCTAssertEqual(fake.badges.last, 1)
        XCTAssertTrue(fake.posts.isEmpty)
        var target: NotificationTarget?
        restored.onOpen = { target = $0 }
        let inbox = try JSONDecoder().decode(NotificationInbox.self, from: Data(contentsOf: url))
        fake.opened?(try XCTUnwrap(inbox.receipts.first).id)
        XCTAssertEqual(target, NotificationTarget(sessionID: "a", epoch: 0))
        let permissions = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
    }
    func testDeliveryFailuresAreReportedWithoutDiscardingUnreadState() async {
        let (controller, fake, defaults, suite) = setup()
        defer { defaults.removePersistentDomain(forName: suite) }
        fake.failPost = true
        controller.receive(notice(), alreadyRead: false)
        await controller.flush()
        XCTAssertNotNil(controller.error)
        XCTAssertEqual(controller.unreadCount, 1)
        XCTAssertEqual(fake.badges.last, 1)
        fake.failBadge = true
        controller.refresh()
        await controller.flush()
        XCTAssertTrue(controller.error?.contains("バッジ") == true)
        XCTAssertEqual(controller.unreadCount, 1)
    }
    func testCorruptJournalIsPreservedAndDeliveryCanStillProceedInMemory() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("inbox.json")
        let original = Data("broken JSON".utf8)
        try original.write(to: url)
        let (controller, fake, defaults, suite) = setup(storage: url)
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertNotNil(controller.error)
        controller.receive(notice(), alreadyRead: false)
        await controller.flush()
        XCTAssertEqual(fake.posts.count, 1)
        XCTAssertEqual(try Data(contentsOf: url), original)
    }
    func testJournalIsBoundedAndRemovesOldSystemIdentifiers() {
        var inbox = NotificationInbox(backend: "https://example.org")
        var removed: [String] = []
        for i in 0..<520 {
            _ = inbox.record(notice(String(i)), alreadyRead: false)
            removed += inbox.trim()
        }
        XCTAssertEqual(inbox.receipts.count, 512)
        XCTAssertEqual(removed.count, 8)
        XCTAssertEqual(inbox.unreadCount, 520, "Trimming delivery metadata must not lose unread counts")
        _ = inbox.markRead(NotificationTarget(sessionID: "a", epoch: 0))
        XCTAssertEqual(inbox.unreadCount, 0)
    }
}
