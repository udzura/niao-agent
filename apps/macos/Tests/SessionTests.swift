import XCTest
@testable import NiaoCore

final class SessionTests: XCTestCase {
    private let sessionJSON = #"{"id":"a","title":"日本語の会話","createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-02T00:00:00.000Z","lastActivityAt":"2026-11-01T01:00:00.000Z","archivedAt":null,"epoch":3,"messageCount":2}"#
    func testCatalogPreservesActivityAndRejectsLateSnapshots() throws {
        let json = "{\"revision\":8,\"retentionDays\":30,\"maxSessions\":50,\"activeSessionId\":\"a\",\"items\":[" + sessionJSON + "]}"
        let catalog = try JSONDecoder().decode(SessionCatalog.self, from: Data(json.utf8))
        XCTAssertNotEqual(catalog.items[0].updatedAt, catalog.items[0].lastActivityAt)
        let deleted = SessionCatalog(revision: 9, retentionDays: 30, maxSessions: 50, activeSessionId: nil, items: [])
        XCTAssertEqual(deleted.accepting(catalog), deleted)
        XCTAssertEqual(catalog.accepting(deleted), deleted)
    }
    func testMultiplexedEventsRetainSessionIdentity() throws {
        let json = #"{"v":2,"type":"partial","sessionId":"conversation-B","epoch":4,"requestId":"turn-B","text":"途中の回答"}"#
        let event = try JSONDecoder().decode(ServerEvent.self, from: Data(json.utf8))
        XCTAssertEqual(event.v, 2)
        XCTAssertEqual(event.sessionId, "conversation-B")
        XCTAssertEqual(event.requestId, "turn-B")
        XCTAssertEqual(event.epoch, 4)
    }
    func testPendingSubmissionsRoundTripAcrossConversationsWithoutReassignment() throws {
        var a = Submission(requestId: "turn-a", content: "送信A", epoch: 2)
        a.v = 2; a.sessionId = "a"
        var b = Submission(requestId: "turn-b", content: "送信B", epoch: 0)
        b.v = 2; b.sessionId = "b"
        let encoded = try JSONEncoder().encode(StoredOutboxes(backend: "https://example.org", submissions: ["a": a, "b": b]))
        let restored = try JSONDecoder().decode(StoredOutboxes.self, from: encoded)
        XCTAssertEqual(restored.submissions["a"]?.epoch, 2)
        XCTAssertEqual(restored.submissions["a"]?.sessionId, "a")
        XCTAssertEqual(restored.submissions["b"]?.content, "送信B")
        XCTAssertEqual(restored.submissions["b"]?.sessionId, "b")
        let legacy = try JSONDecoder().decode(StoredSubmission.self, from: Data(#"{"backend":"https://example.org","submission":{"v":1,"type":"send","requestId":"old","content":"preserved","epoch":2}}"#.utf8))
        XCTAssertNil(legacy.submission.sessionId)
        XCTAssertEqual(legacy.submission.content, "preserved")
    }
    func testNewestAndOlderPagesDecodeIndependentBoundaries() throws {
        let json = #"{"v":2,"sessionId":"a","epoch":0,"messages":[],"cursor":205,"beforeCursor":106,"hasMore":false,"hasOlder":true,"turns":[],"active":null}"#
        let page = try JSONDecoder().decode(HistoryPage.self, from: Data(json.utf8))
        XCTAssertEqual(page.sessionId, "a")
        XCTAssertEqual(page.cursor, 205)
        XCTAssertEqual(page.beforeCursor, 106)
        XCTAssertEqual(page.hasOlder, true)
        XCTAssertFalse(page.hasMore)
    }
}
