import XCTest
@testable import NiaoCore

final class HistoryLoadStateTests: XCTestCase {
    func testInitialLoadEmptySuccessAndFailureAreDistinct() {
        var state = HistoryLoadState()
        XCTAssertEqual(state.phase, .idle)
        let load = state.begin()
        XCTAssertTrue(state.isLoading)
        XCTAssertNil(state.error)
        state.finish(load)
        XCTAssertEqual(state.phase, .loaded)
        XCTAssertFalse(state.isLoading)
        let retry = state.begin()
        state.fail(retry, message: "接続できませんでした")
        XCTAssertEqual(state.error, "接続できませんでした")
        XCTAssertFalse(state.isLoading)
    }
    func testLateResponsesFromPreviousSelectionCannotFinishOrFailANewerLoad() {
        var state = HistoryLoadState()
        let old = state.begin(), current = state.begin()
        state.finish(old)
        XCTAssertTrue(state.isLoading)
        state.fail(old, message: "古い会話のエラー")
        XCTAssertNil(state.error)
        XCTAssertTrue(state.isLoading)
        state.finish(current)
        XCTAssertEqual(state.phase, .loaded)
    }
    func testRetryClearsFailureAndSuspendIgnoresLateCompletion() {
        var state = HistoryLoadState()
        state.fail(state.begin(), message: "一時的な失敗")
        let retry = state.begin()
        XCTAssertNil(state.error)
        state.reset()
        state.fail(retry, message: "キャンセルされた通信の失敗")
        state.finish(retry)
        XCTAssertEqual(state.phase, .idle)
    }
}
