import XCTest
@testable import NiaoCore

final class BackgroundResultNotificationTests: XCTestCase {
    private func session() -> ChatSession {
        ChatSession(id: "a", title: "日本語の会話", createdAt: "", updatedAt: "", lastActivityAt: "", archivedAt: nil, epoch: 0, messageCount: 1)
    }
    private func event(kind: String = "notification", sessionID: String = "a", epoch: Int = 0,
                       type: String = "message_added", role: String = "assistant", text: String = "記事の要約です。", messageRequestID: String? = nil) throws -> ServerEvent {
        let requestID = "\(kind):1"
        let data = try JSONSerialization.data(withJSONObject: [
            "v": 2, "type": type, "sessionId": sessionID, "epoch": epoch, "requestId": requestID,
            "message": ["seq": 1, "id": requestID, "requestId": messageRequestID ?? requestID, "role": role, "content": text, "createdAt": "2026-11-02T00:00:00.000Z"]
        ])
        return try JSONDecoder().decode(ServerEvent.self, from: data)
    }
    func testOnlyDurableBackgroundResultsNotify() throws {
        for type in ["partial", "committed", "jobs_updated", "notification_deferred"] {
            XCTAssertNil(BackgroundResultNotification.from(try event(type: type), session: session()))
        }
        XCTAssertNil(BackgroundResultNotification.from(try event(kind: "ordinary"), session: session()))
        let notice = try XCTUnwrap(BackgroundResultNotification.from(try event(), session: session()))
        XCTAssertEqual(notice.id, "a:notification:1")
        XCTAssertEqual(notice.sessionID, "a")
        XCTAssertEqual(notice.title, "記事取得の結果が届きました")
    }
    func testInvalidSessionEpochRoleAndTurnAreRejected() throws {
        XCTAssertNil(BackgroundResultNotification.from(try event(sessionID: "b"), session: session()))
        XCTAssertNil(BackgroundResultNotification.from(try event(epoch: 1), session: session()))
        XCTAssertNil(BackgroundResultNotification.from(try event(role: "user"), session: session()))
        XCTAssertNil(BackgroundResultNotification.from(try event(messageRequestID: "another-turn"), session: session()))
    }
    func testFailedFetchIsNotPresentedAsSuccessAndReminderRemainsDistinct() throws {
        let failed = try XCTUnwrap(BackgroundResultNotification.from(try event(text: "取得できませんでした。"), session: session()))
        XCTAssertEqual(failed.title, "記事取得の結果が届きました")
        XCTAssertTrue(failed.preview.contains("取得できませんでした"))
        let reminder = try XCTUnwrap(BackgroundResultNotification.from(try event(kind: "reminder"), session: session()))
        XCTAssertEqual(reminder.title, "リマインダー")
    }
    func testPreviewIsBoundedAndPreservesUnicode() throws {
        let notice = try XCTUnwrap(BackgroundResultNotification.from(try event(text: "\n" + String(repeating: "鳥🐦 ", count: 100)), session: session()))
        XCTAssertLessThanOrEqual(notice.preview.count, 121)
        XCTAssertTrue(notice.preview.hasSuffix("…"))
        XCTAssertFalse(notice.preview.contains("\n"))
        XCTAssertTrue(notice.preview.contains("🐦"))
    }
}
