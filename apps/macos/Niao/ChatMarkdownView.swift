import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct ChatMarkdownView: View {
    let content: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(ChatMarkdown.blocks(content)) { block in
                switch block.kind {
                case .paragraph:
                    inline(block.text)
                case .heading(let level):
                    inline(block.text).font(headingFont(level)).fontWeight(.semibold).padding(.top, 4)
                case .list(let marker, let depth):
                    HStack(alignment: .top, spacing: 8) {
                        Text(marker).monospacedDigit().foregroundStyle(.secondary)
                        inline(block.text)
                    }.padding(.leading, CGFloat(depth) * 12)
                case .quote:
                    HStack(alignment: .top, spacing: 10) {
                        RoundedRectangle(cornerRadius: 2).fill(.tertiary).frame(width: 3)
                        inline(block.text).foregroundStyle(.secondary)
                    }.fixedSize(horizontal: false, vertical: true)
                case .code(let language):
                    MarkdownCodeView(code: block.text, language: language)
                case .rule:
                    Divider().padding(.vertical, 4)
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
    }
    private func inline(_ source: String) -> Text { Text(ChatMarkdown.inline(source)) }
    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title2
        case 2: .title3
        default: .headline
        }
    }
}
private struct MarkdownCodeView: View {
    let code: String
    let language: String
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(language.isEmpty ? "コード" : language).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button {
                    #if os(macOS)
                    NSPasteboard.general.clearContents()
                    copied = NSPasteboard.general.setString(code, forType: .string)
                    #else
                    UIPasteboard.general.string = code
                    copied = true
                    #endif
                } label: {
                    Label(copied ? "コピー済み" : "コピー", systemImage: copied ? "checkmark" : "doc.on.doc")
                }.buttonStyle(.borderless).font(.caption).help("コードをコピー")
            }
            ScrollView(.horizontal) {
                Text(verbatim: code).font(.system(.body, design: .monospaced))
                    .fixedSize(horizontal: true, vertical: false)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }.padding(12).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
            .onChange(of: code) { _, _ in copied = false }
    }
}
