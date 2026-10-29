import XCTest
@testable import NiaoCore

final class ChatMarkdownTests: XCTestCase {
    func testHeadingsParagraphsListsQuotesAndRules() {
        let blocks = ChatMarkdown.blocks("# 見出し\r\n\r\n文章\r\n次の行\r\n\r\n- 項目\r\n  続き\r\n  1. 内側\r\n\r\n> 引用\r\n> 二行目\r\n\r\n---")
        XCTAssertEqual(blocks.map(\.kind), [.heading(1), .paragraph, .list(marker: "•", depth: 0), .list(marker: "1.", depth: 1), .quote, .rule])
        XCTAssertEqual(blocks[1].text, "文章\n次の行")
        XCTAssertEqual(blocks[2].text, "項目\n続き")
        XCTAssertEqual(blocks[4].text, "引用\n二行目")
        XCTAssertEqual(ChatMarkdown.blocks("## 名前 ###").first?.text, "名前")
        XCTAssertEqual(ChatMarkdown.blocks("2. 二番目\n3) 三番目").map(\.kind), [.list(marker:"2.",depth:0),.list(marker:"3)",depth:0)])
    }
    func testFencedCodePreservesSyntaxIndentationAndLineBreaks() {
        let blocks = ChatMarkdown.blocks("前\n\n```ruby\nif true\n  puts \"**そのまま**\"\nend\n```\n\n後")
        XCTAssertEqual(blocks.count, 3)
        XCTAssertEqual(blocks[1].kind, .code(language:"ruby"))
        XCTAssertEqual(blocks[1].text, "if true\n  puts \"**そのまま**\"\nend\n")
        let longFence = ChatMarkdown.blocks("````text\n```\n# code\n````")
        XCTAssertEqual(longFence.count, 1)
        XCTAssertEqual(longFence[0].text, "```\n# code\n")
        XCTAssertEqual(ChatMarkdown.blocks("~~~\nx\n~~~")[0].kind, .code(language:""))
    }
    func testStreamingUnclosedFenceRetainsContentAndStableBlockIdentity() {
        let before = ChatMarkdown.blocks("回答\n\n```swift\nlet x =")
        let after = ChatMarkdown.blocks("回答\n\n```swift\nlet x = 1\n```")
        XCTAssertEqual(before.last?.kind, .code(language:"swift"))
        XCTAssertEqual(before.last?.text, "let x =")
        XCTAssertEqual(before.map(\.id), after.map(\.id))
        XCTAssertEqual(after.last?.text, "let x = 1\n")
        XCTAssertEqual(ChatMarkdown.blocks("```\n").last?.text, "")
        XCTAssertTrue(ChatMarkdown.blocks("  \n").isEmpty)
    }
    func testInlineFormattingAndWhitespace() {
        let text = ChatMarkdown.inline("**太字** と *斜体* と `a < b`\n[資料](https://example.com)")
        XCTAssertEqual(String(text.characters), "太字 と 斜体 と a < b\n資料")
        XCTAssertTrue(text.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        XCTAssertTrue(text.runs.contains { $0.inlinePresentationIntent?.contains(.emphasized) == true })
        XCTAssertTrue(text.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
        XCTAssertTrue(text.runs.contains { $0.link?.absoluteString == "https://example.com" })
        XCTAssertFalse(String(ChatMarkdown.inline("未完の **強調").characters).isEmpty)
    }
    func testOnlyWebAndEmailLinksRemainInteractive() {
        let safe = ChatMarkdown.inline("[web](https://example.com) [mail](mailto:test@example.com)")
        XCTAssertEqual(safe.runs.filter { $0.link != nil }.count, 2)
        let unsafe = ChatMarkdown.inline("[file](file:///etc/passwd) [script](javascript:alert) [relative](/local)")
        XCTAssertFalse(unsafe.runs.contains { $0.link != nil })
        XCTAssertTrue(String(unsafe.characters).contains("file"))
    }
}
