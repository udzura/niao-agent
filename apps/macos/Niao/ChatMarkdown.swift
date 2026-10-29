import Foundation

// Deliberately small block layout; inline Markdown uses Foundation's parser.
// IDs are source line offsets so streaming text updates the existing final block.
struct ChatMarkdownBlock: Identifiable, Equatable {
    enum Kind: Equatable {
        case paragraph, heading(Int), list(marker: String, depth: Int), quote, code(language: String), rule
    }
    let id: Int
    let kind: Kind
    var text: String
}
enum ChatMarkdown {
    private static let heading = try! NSRegularExpression(pattern: #"^ {0,3}(#{1,6})[ \t]+(.*)$"#)
    private static let list = try! NSRegularExpression(pattern: #"^( *)([-+*]|[0-9]{1,9}[.)])[ \t]+(.*)$"#)
    private static let fence = try! NSRegularExpression(pattern: #"^ {0,3}(`{3,}|~{3,})(.*)$"#)
    private static func groups(_ regex: NSRegularExpression, _ line: String) -> [String]? {
        guard let match = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) else { return nil }
        return (1..<match.numberOfRanges).map { index in
            Range(match.range(at: index), in: line).map { String(line[$0]) } ?? ""
        }
    }
    static func blocks(_ source: String) -> [ChatMarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
        var blocks: [ChatMarkdownBlock] = []
        var buffer: ChatMarkdownBlock?
        var fenceMarker: String?
        var codeLines: [String] = []
        func flush() {
            if let value = buffer { blocks.append(value) }
            buffer = nil
        }
        for (index, line) in lines.enumerated() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let marker = fenceMarker {
                if let close = groups(fence, line), close[0].first == marker.first,
                   close[0].count >= marker.count, close[1].trimmingCharacters(in: .whitespaces).isEmpty {
                    buffer?.text = codeLines.joined(separator: "\n") + (codeLines.isEmpty ? "" : "\n")
                    flush(); fenceMarker = nil; codeLines = []
                } else { codeLines.append(line) }
                continue
            }
            if let open = groups(fence, line) {
                flush()
                fenceMarker = open[0]
                let language = open[1].trimmingCharacters(in: .whitespaces).split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
                buffer = ChatMarkdownBlock(id: index, kind: .code(language: language), text: "")
                continue
            }
            if trimmed.isEmpty { flush(); continue }
            if let title = groups(heading, line) {
                flush()
                blocks.append(ChatMarkdownBlock(id: index, kind: .heading(title[0].count),
                    text: title[1].replacingOccurrences(of: #"[ \t]+#+[ \t]*$"#, with: "", options: .regularExpression)))
            } else if ["-", "*", "_"].contains(String(trimmed.first!)),
                      trimmed.filter({ !$0.isWhitespace }).count >= 3,
                      Set(trimmed.filter { !$0.isWhitespace }).count == 1 {
                flush(); blocks.append(ChatMarkdownBlock(id: index, kind: .rule, text: ""))
            } else if let item = groups(list, line) {
                flush()
                let marker = ["-", "+", "*"].contains(item[1]) ? "•" : item[1]
                buffer = ChatMarkdownBlock(id: index, kind: .list(marker: marker, depth: min(item[0].count / 2, 8)), text: item[2])
            } else if trimmed.hasPrefix(">") {
                let quote = String(trimmed.dropFirst()).replacingOccurrences(of: #"^ ?"#, with: "", options: .regularExpression)
                if buffer?.kind == .quote { buffer?.text += "\n" + quote }
                else { flush(); buffer = ChatMarkdownBlock(id: index, kind: .quote, text: quote) }
            } else if case .list = buffer?.kind, line.hasPrefix("  ") {
                buffer?.text += "\n" + trimmed
            } else if buffer?.kind == .paragraph { buffer?.text += "\n" + line }
            else { flush(); buffer = ChatMarkdownBlock(id: index, kind: .paragraph, text: line) }
        }
        if fenceMarker != nil { buffer?.text = codeLines.joined(separator: "\n") }
        flush()
        return blocks
    }
    static func inline(_ source: String) -> AttributedString {
        var text = (try? AttributedString(markdown: source,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(source)
        // Only deliberate web/email links should open from chat content.
        let unsafeLinks = text.runs.compactMap { run in
            guard let url = run.link, !["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return nil as Range<AttributedString.Index>? }
            return run.range
        }
        for range in unsafeLinks { text[range].link = nil }
        return text
    }
}
