import SwiftUI

struct ToolCallToastOverlay: View {
    @ObservedObject var store: ChatStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            if let notice = store.toolToast.notice, notice.expiresAt > Date() {
                ToolCallToastView(notice: notice)
                    .id(notice.id)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)).combined(with: .scale(scale: 0.96, anchor: .bottomTrailing)))
                    .task(id: notice.id) {
                        do { try await Task.sleep(for: .seconds(max(0, notice.expiresAt.timeIntervalSinceNow))) }
                        catch { return }
                        store.toolToast.dismiss(id: notice.id)
                    }
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.32, dampingFraction: 0.85), value: store.toolToast.notice?.id)
        .padding(16)
        .allowsHitTesting(false)
    }
}
struct ToolCallToastView: View {
    let notice: ToolCallToast
    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "terminal").font(.body.weight(.medium)).foregroundStyle(Color.accentColor)
            Text(verbatim: notice.name).font(.system(.callout, design: .monospaced).weight(.medium)).lineLimit(1).truncationMode(.middle)
            Text("を使用").font(.callout).foregroundStyle(.secondary)
            if notice.count > 1 { Text("×\(notice.count)").font(.caption.weight(.semibold)).monospacedDigit() }
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(.primary.opacity(0.08)) }
        .shadow(color: .black.opacity(0.1), radius: 8, y: 3)
        .accessibilityElement(children: .combine)
    }
}
