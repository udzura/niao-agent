import XCTest
@testable import NiaoCore

final class NiaoCoreTests: XCTestCase {
    func testCredentialDestinationValidation() throws {
        for value in ["https://niao.example.com", "http://127.0.0.1:8787", "http://localhost:8787"] {
            XCTAssertNoThrow(try BackendURL.validate(value))
        }
        for value in ["http://example.com", "ftp://example.com", "https://user:secret@example.com", "https://example.com?token=secret", "https://example.com/path", "https://example.com#fragment"] {
            XCTAssertThrowsError(try BackendURL.validate(value))
        }
    }
    func testHistoryAndSocketReplayMergeByIDAndStableOrder() {
        let user = ChatMessage(seq: 1, id: "u", requestId: "r", role: "user", content: "hello", createdAt: "now")
        let assistant = ChatMessage(seq: 2, id: "a", requestId: "r", role: "assistant", content: "hi", createdAt: "now")
        XCTAssertEqual(mergeMessages([assistant], [user, assistant, user]), [user, assistant])
    }
    func testPartialIsNotAPersistedMessage() throws {
        let event = try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"v":1,"type":"partial","requestId":"r","text":"途中"}"#.utf8))
        XCTAssertEqual(event.text, "途中")
        XCTAssertNil(event.message)
        XCTAssertNil(event.messages)
    }
    func testHistoryDecodesFailureAndCursor() throws {
        let page = try JSONDecoder().decode(HistoryPage.self, from: Data(#"{"v":1,"messages":[],"cursor":42,"hasMore":false,"turns":[{"requestId":"r","status":"failed","errorCode":"interrupted"}],"active":null}"#.utf8))
        XCTAssertEqual(page.cursor, 42)
        XCTAssertEqual(page.turns[0].errorCode, "interrupted")
    }
    func testUsageScopeAndUTCRollover() throws {
        let raw = #"{"v":1,"dayStart":"2026-10-27T00:00:00.000Z","dayEnd":"2026-10-28T00:00:00.000Z","asOf":"2026-10-27T12:00:00.000Z","account":{"status":"not_configured","neurons":null,"queriedAt":null,"errorCode":"analytics_not_configured"},"local":{"neurons":2.5,"attempts":2,"unmeasuredAttempts":1,"trackingSince":"2026-10-27T10:00:00Z"}}"#
        let usage = try JSONDecoder().decode(UsageSnapshot.self, from: Data(raw.utf8))
        XCTAssertFalse(usage.accountAvailable)
        XCTAssertEqual(usage.scopeLabel, "Niao 記録分")
        XCTAssertEqual(usage.displayedNeurons, 2.5)
        XCTAssertTrue(usage.isCurrent(at: Date(timeIntervalSince1970: 1793102400)))
        XCTAssertFalse(usage.isCurrent(at: Date(timeIntervalSince1970: 1793145600)))
        let accountRaw = raw.replacingOccurrences(of: #""status":"not_configured","neurons":null"#, with: #""status":"available","neurons":23.35"#)
        let account = try JSONDecoder().decode(UsageSnapshot.self, from: Data(accountRaw.utf8))
        XCTAssertEqual(account.scopeLabel, "アカウント全体")
        XCTAssertEqual(account.displayedNeurons, 23.35)
    }

    func testSubmissionPersistsConversationEpoch() throws {
        let submission = Submission(requestId: "r", content: "hello", epoch: 7)
        let data = try JSONEncoder().encode(submission)
        XCTAssertEqual(try JSONDecoder().decode(Submission.self, from: data).epoch, 7)
        let legacy = try JSONDecoder().decode(Submission.self, from: Data(#"{"v":1,"type":"send","requestId":"r","content":"hello"}"#.utf8))
        XCTAssertNil(legacy.epoch)
    }
    func testControlEventDecoding() throws {
        let data = Data(#"{"v":1,"type":"settings_updated","epoch":2,"settings":{"v":1,"epoch":2,"modelId":"model","models":[{"id":"model","name":"Example"}]}}"#.utf8)
        let event = try JSONDecoder().decode(ServerEvent.self, from: data)
        XCTAssertEqual(event.epoch, 2)
        XCTAssertEqual(event.settings?.modelId, "model")
    }

}
