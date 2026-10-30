import XCTest
@testable import NiaoCore

final class PlatformUsageTests: XCTestCase {
    private let raw = #"{"v":1,"dayStart":"2026-10-30T00:00:00.000Z","dayEnd":"2026-10-31T00:00:00.000Z","asOf":"2026-10-30T12:00:00Z","workers":{"status":"available","requests":1454,"queriedAt":"2026-10-30T12:00:00Z","errorCode":null},"durableObjects":{"status":"available","durationGbSeconds":210.633207296,"queriedAt":"2026-10-30T12:00:00Z","errorCode":null},"plan":{"status":"unavailable","name":null,"queriedAt":null,"errorCode":"analytics_http_403"}}"#
    func testPartialFailureDoesNotBecomeFreeOrHideUsage() throws {
        let snapshot = try JSONDecoder().decode(PlatformUsageSnapshot.self, from: Data(raw.utf8))
        XCTAssertEqual(snapshot.workers.requests, 1454)
        XCTAssertEqual(snapshot.durableObjects.durationGbSeconds, 210.633207296)
        XCTAssertEqual(snapshot.plan.label, "未確認")
        XCTAssertEqual(snapshot.plan.errorCode, "analytics_http_403")
        XCTAssertTrue(snapshot.isCurrent(at: try XCTUnwrap(UsageSnapshot.parseDate("2026-10-30T00:00:00Z"))))
        XCTAssertFalse(snapshot.isCurrent(at: try XCTUnwrap(UsageSnapshot.parseDate("2026-10-31T00:00:00Z"))))
    }
    func testVerifiedPlanLabels() throws {
        for (name, label) in [("free", "Workers Free"), ("paid", "Workers Paid"), ("unknown", "未確認")] {
            let verified = raw.replacingOccurrences(of: #""status":"unavailable","name":null"#, with: "\"status\":\"available\",\"name\":\"\(name)\"")
            let snapshot = try JSONDecoder().decode(PlatformUsageSnapshot.self, from: Data(verified.utf8))
            XCTAssertEqual(snapshot.plan.label, label)
        }
    }
}
