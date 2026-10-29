import XCTest
@testable import NiaoCore

final class ThinkingTests: XCTestCase {
    func testLegacyMessagesHaveNoThinkingAndNewHistoryRestoresSegments() throws {
        let legacy = #"{"seq":1,"id":"a","requestId":"r","role":"assistant","content":"answer","createdAt":"now"}"#
        XCTAssertNil(try JSONDecoder().decode(ChatMessage.self, from: Data(legacy.utf8)).thinking)
        let raw = legacy.dropLast() + #", "thinking":[{"generation":0,"text":"before tool\n  whitespace","active":false},{"generation":1,"text":"after tool","active":false}]}"#
        let message = try JSONDecoder().decode(ChatMessage.self, from: Data(raw.utf8))
        XCTAssertEqual(message.content, "answer")
        XCTAssertEqual(message.thinking?.map(\.generation), [0,1])
        XCTAssertEqual(message.thinking?.first?.text, "before tool\n  whitespace")
        let restored = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(message))
        XCTAssertEqual(restored, message)
    }
    func testStreamingAndHTTPActiveSnapshotsKeepThinkingApartFromAnswer() throws {
        let event = try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"v":1,"type":"partial","requestId":"r","text":"answer","thinking":[{"generation":0,"text":"thinking","active":true}]}"#.utf8))
        let partial = PartialMessage(requestId: event.requestId!,text: event.text!,thinking:event.thinking)
        XCTAssertEqual(partial.text, "answer")
        XCTAssertEqual(partial.thinking?.first?.active, true)
        let restored = try JSONDecoder().decode(PartialMessage.self, from: JSONEncoder().encode(partial))
        XCTAssertEqual(restored.thinking, partial.thinking)
        XCTAssertEqual(restored.thinking?.first?.text, "thinking")
    }
}
