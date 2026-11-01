import XCTest
@testable import NiaoCore

final class BackgroundJobsTests: XCTestCase {
    func testSnapshotsDecodeAndRejectOlderRevisions() throws {
        let json = #"{"v":1,"type":"jobs_updated","epoch":2,"jobs":{"revision":8,"items":[{"id":"r1","kind":"reminder","title":"お茶","status":"scheduled","dueAt":"2026-11-01T04:30:00.000Z"},{"id":"f1","kind":"web_fetch","title":"example.org","status":"notifying"}]}}"#
        let event = try JSONDecoder().decode(ServerEvent.self, from: Data(json.utf8))
        let snapshot = try XCTUnwrap(event.jobs)
        XCTAssertEqual(snapshot.items[0].label, "リマインダー")
        XCTAssertNotNil(snapshot.items[0].scheduledDate)
        XCTAssertEqual(snapshot.items[1].statusLabel, "要約を生成中")
        let completed = BackgroundJobsSnapshot(revision: 9, items: [])
        XCTAssertEqual(snapshot.accepting(completed), completed)
        XCTAssertEqual(completed.accepting(snapshot), completed)
        XCTAssertEqual(snapshot.accepting(snapshot), snapshot)
    }
    func testOlderServerStillDecodesWithoutJobs() throws {
        let event = try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"v":1,"type":"ready","epoch":0}"#.utf8))
        XCTAssertNil(event.jobs)
        let history = try JSONDecoder().decode(HistoryPage.self, from: Data(#"{"v":1,"epoch":0,"messages":[],"cursor":0,"hasMore":false,"turns":[]}"#.utf8))
        XCTAssertNil(history.jobs)
    }
}
