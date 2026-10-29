import XCTest
@testable import NiaoCore

final class ToolStatisticsTests: XCTestCase {
    func testPairsNotificationsWithoutCollapsingMultipleCallsInOneTurn() {
        var stats = ToolStatistics()
        let session = stats.beginSession()
        func record(_ status: String) {
            stats.observe(sessionID: session, backend: "https://example.com", epoch: 0, requestID: "turn", name: "ruby_eval", status: status)
        }
        record("running"); record("running")
        XCTAssertEqual(stats.totals["ruby_eval"]?.calls, 1)
        record("completed"); record("completed")
        record("running"); record("completed")
        record("running")
        XCTAssertEqual(stats.totals["ruby_eval"]?.calls, 3)
        XCTAssertEqual(stats.totals["ruby_eval"]?.completed, 2)
        XCTAssertEqual(stats.totals["ruby_eval"]?.unconfirmed, 1)
        stats.finishTurn(backend: "https://example.com", epoch: 0, requestID: "turn")
        record("running"); record("completed")
        XCTAssertEqual(stats.totals["ruby_eval"]?.calls, 4)
        XCTAssertEqual(stats.totals["ruby_eval"]?.completed, 3)
    }
    func testCountsCompletionWithoutStartAndSeparatesBackendEpochAndTool() {
        var stats = ToolStatistics()
        let session = stats.beginSession()
        for (backend, epoch, name) in [("a",0,"ruby_eval"),("b",0,"ruby_eval"),("a",1,"ruby_eval"),("a",0,"other")] {
            stats.observe(sessionID: session, backend: backend, epoch: epoch, requestID: "turn", name: name, status: "completed")
        }
        XCTAssertEqual(stats.totals["ruby_eval"]?.calls, 3)
        XCTAssertEqual(stats.totals["ruby_eval"]?.completed, 3)
        XCTAssertEqual(stats.totals["other"]?.calls, 1)
        stats.observe(sessionID: session, backend: "a", epoch: 0, requestID: "turn", name: "ruby_eval", status: "unknown")
        XCTAssertEqual(stats.sessions[0].calls, 4)
    }
    func testPersistsSessionTotalsAndPermissionsWithoutConversationIdentifiers() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appendingPathComponent("stats.json")
        var stats = try ToolStatistics.load(from: url)
        let session = stats.beginSession(at: Date(timeIntervalSince1970: 100))
        stats.observe(sessionID: session, backend: "private-backend", epoch: 0, requestID: "private-turn", name: "ruby_eval", status: "running")
        try stats.save(to: url)
        let raw = try String(contentsOf: url, encoding: .utf8)
        XCTAssertFalse(raw.contains("private-backend")); XCTAssertFalse(raw.contains("private-turn"))
        let permissions = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
        var restored = try ToolStatistics.load(from: url)
        let next = restored.beginSession(at: Date(timeIntervalSince1970: 200))
        restored.observe(sessionID: next, backend: "private-backend", epoch: 0, requestID: "next", name: "ruby_eval", status: "completed")
        XCTAssertEqual(restored.sessions.count, 2)
        XCTAssertEqual(restored.sessions[0].calls, 1)
        XCTAssertEqual(restored.sessions[0].completed, 0)
        XCTAssertEqual(restored.sessions[1].calls, 1)
        XCTAssertEqual(restored.totals["ruby_eval"]?.calls, 2)
        try Data("broken".utf8).write(to: url)
        XCTAssertThrowsError(try ToolStatistics.load(from: url))
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "broken")
    }
    func testDecodesExistingServerToolEvent() throws {
        let event = try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"v":1,"epoch":1,"type":"tool_status","requestId":"turn","name":"ruby_eval","status":"running"}"#.utf8))
        XCTAssertEqual(event.name, "ruby_eval")
        XCTAssertEqual(event.status, "running")
    }
}
