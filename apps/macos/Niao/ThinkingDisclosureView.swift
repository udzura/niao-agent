import SwiftUI

struct ThinkingDisclosureView: View {
    let segments: [ThinkingSegment]
    @State private var expanded = false
    private var visible: [ThinkingSegment] { segments.filter { !$0.text.isEmpty || $0.active }.sorted { $0.generation < $1.generation } }
    var body: some View {
        if !visible.isEmpty {
            DisclosureGroup(isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(visible) { segment in
                        VStack(alignment: .leading, spacing: 6) {
                            if visible.count > 1 || segment.generation > 0 {
                                Text("生成 \(segment.generation + 1)").font(.caption.weight(.medium))
                            }
                            if !segment.text.isEmpty {
                                Text(verbatim: segment.text).font(.callout).textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                }.foregroundStyle(.secondary).padding(10)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
            } label: {
                HStack(spacing: 6) {
                    Text("思考過程")
                    if visible.contains(where: \.active) {
                        ProgressView().controlSize(.small)
                        Text("思考中…")
                    }
                }.font(.caption).foregroundStyle(.secondary)
            }.padding(.bottom, 4)
        }
    }
}
