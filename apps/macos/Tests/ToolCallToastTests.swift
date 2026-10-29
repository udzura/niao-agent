import XCTest
@testable import NiaoCore

final class ToolCallToastTests: XCTestCase {
    func testRepeatedCallsExtendTheDisplayAndOldTimersCannotDismissTheNewToast() throws {
        var state = ToolCallToastState()
        let now = Date(timeIntervalSince1970: 100)
        state.show(name: "ruby_eval", at: now)
        let first = try XCTUnwrap(state.notice)
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(first.expiresAt, now.addingTimeInterval(3.5))
        state.show(name: "ruby_eval", at: now.addingTimeInterval(1))
        let second = try XCTUnwrap(state.notice)
        XCTAssertNotEqual(first.id, second.id)
        XCTAssertEqual(second.count, 2)
        XCTAssertEqual(second.expiresAt, now.addingTimeInterval(4.5))
        state.dismiss(id: first.id)
        XCTAssertEqual(state.notice?.id, second.id)
        state.dismiss(id: second.id)
        XCTAssertNil(state.notice)
    }
    func testExpiredOrDifferentToolsStartAFreshToastAndClearRemovesIt() {
        var state = ToolCallToastState()
        let now = Date(timeIntervalSince1970: 100)
        state.show(name: "ruby_eval", at: now)
        state.show(name: "ruby_eval", at: now.addingTimeInterval(4))
        XCTAssertEqual(state.notice?.count, 1)
        state.show(name: "another_tool", at: now.addingTimeInterval(5))
        XCTAssertEqual(state.notice?.name, "another_tool")
        XCTAssertEqual(state.notice?.count, 1)
        state.clear()
        XCTAssertNil(state.notice)
    }
    func testOnlyNewObservedCallsTriggerToastsNotEveryStatusNotification() {
        var stats = ToolStatistics()
        let session = stats.beginSession()
        func observe(_ status: String) -> Bool {
            stats.observe(sessionID: session, backend: "example", epoch: 0, requestID: "turn", name: "ruby_eval", status: status)
        }
        XCTAssertTrue(observe("running"))
        XCTAssertFalse(observe("running"))
        XCTAssertFalse(observe("completed"))
        XCTAssertFalse(observe("completed"))
        XCTAssertTrue(observe("running")) // Second invocation in the same turn.
        XCTAssertFalse(observe("completed"))
        XCTAssertFalse(observe("unknown"))
        stats.finishTurn(backend: "example", epoch: 0, requestID: "turn")
        let unseenStart = stats.observe(sessionID: session, backend: "example", epoch: 0, requestID: "other", name: "ruby_eval", status: "completed")
        XCTAssertTrue(unseenStart)
    }
}
