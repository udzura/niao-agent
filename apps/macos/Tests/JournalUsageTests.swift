import XCTest
@testable import NiaoCore

final class JournalUsageTests: XCTestCase {
    private let summary = #"{"attempts":2,"incompleteAttempts":0,"unmeasuredAttempts":0,"reportedAttempts":1,"estimatedAttempts":1,"reportedNeurons":3,"estimatedNeurons":1.45456,"inputTokens":220,"outputTokens":50,"untrackedJobs":0,"complete":true,"source":"mixed","neurons":4.45456,"recordedNeurons":4.45456}"#
    private func detail(session: String = "session-a", job: String = "null", attempt: String = "attempt-a", more: Bool = true) throws -> JournalUsageDetail {
        let raw = """
        {"v":1,"reportSessionId":"\(session)","jobId":\(job),"trackingSince":"2026-11-03T01:00:00Z","summary":\(summary),
        "attempts":[{"cursor":2,"id":"\(attempt)","jobId":"job-a","model":"@cf/google/gemma-4-26b-a4b-it","round":0,
        "startedAt":"2026-11-03T01:00:00Z","status":"completed","inputTokens":100,"outputTokens":20,"neurons":1.45456,"source":"estimated"}],
        "hasMore":\(more),"nextCursor":2}
        """
        return try JSONDecoder().decode(JournalUsageDetail.self, from: Data(raw.utf8))
    }
    func testDecodeMixedUsageKeepsEstimateAndReturnedValuesSeparate() throws {
        let value = try detail()
        XCTAssertEqual(value.summary.confirmedTotal, 4.45456)
        XCTAssertEqual(value.summary.reportedNeurons, 3)
        XCTAssertEqual(value.summary.estimatedNeurons, 1.45456)
        XCTAssertEqual(value.summary.sourceLabel, "返却値と推定値")
        XCTAssertEqual(value.attempts[0].sourceLabel, "推定値")
        XCTAssertEqual(value.attempts[0].inputTokens, 100)
    }
    func testIncompleteUsageNeverDisplaysRecordedAmountAsTheTotal() throws {
        let raw = summary.replacingOccurrences(of: #""complete":true"#, with: #""complete":false"#)
            .replacingOccurrences(of: #""source":"mixed""#, with: #""source":"incomplete""#)
        let value = try JSONDecoder().decode(JournalUsageSummary.self, from: Data(raw.utf8))
        XCTAssertNil(value.confirmedTotal)
        XCTAssertEqual(value.recordedNeurons, 4.45456)
        XCTAssertEqual(value.sourceLabel, "使用量に不明分あり")
    }
    func testUnavailableSessionIsNotZeroAndEpochMillisecondsDecodeAsADate() throws {
        let raw = #"{"v":1,"sessions":[{"reportSessionId":"a","createdAt":1000,"expiresAt":43201000,"status":"unavailable"}],"hasMore":false,"nextCursor":1}"#
        let page = try JSONDecoder().decode(JournalUsagePage.self, from: Data(raw.utf8))
        XCTAssertNil(page.sessions[0].availableSummary)
        XCTAssertEqual(page.sessions[0].started, Date(timeIntervalSince1970: 1))
        XCTAssertEqual(page.appending(page).sessions.count, 1)
    }
    func testPaginationKeepsLoadedAttemptsAndRejectsMixingJobOrSessionScopes() throws {
        let first = try detail(), second = try detail(attempt: "attempt-b", more: false)
        let merged = try first.appending(second).appending(second)
        XCTAssertEqual(merged.attempts.map(\.id), ["attempt-a", "attempt-b"])
        XCTAssertFalse(merged.hasMore)
        XCTAssertEqual(merged.summary.confirmedTotal, first.summary.confirmedTotal) // Aggregate is not added per page.
        XCTAssertThrowsError(try first.appending(detail(session: "session-b")))
        XCTAssertThrowsError(try first.appending(detail(job: #""job-a""#)))
        XCTAssertTrue(JournalUsageTarget.session("session-a").matches(first))
        XCTAssertFalse(JournalUsageTarget.job("job-a").matches(first))
        XCTAssertFalse(JournalUsageTarget.session("session-a").matches(try detail(job: #""job-a""#)))
    }
    func testTrackedNoInferenceCanDisplayZero() throws {
        let raw = #"{"attempts":0,"incompleteAttempts":0,"unmeasuredAttempts":0,"reportedAttempts":0,"estimatedAttempts":0,"reportedNeurons":0,"estimatedNeurons":0,"inputTokens":0,"outputTokens":0,"untrackedJobs":0,"complete":true,"source":"no_inference","neurons":0,"recordedNeurons":0}"#
        let value = try JSONDecoder().decode(JournalUsageSummary.self, from: Data(raw.utf8))
        XCTAssertEqual(value.confirmedTotal, 0)
        XCTAssertEqual(value.sourceLabel, "推論なし")
    }
}
