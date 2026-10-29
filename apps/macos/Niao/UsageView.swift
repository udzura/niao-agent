import SwiftUI

struct UsageView: View {
    @ObservedObject var store: ChatStore
    var body: some View {
        // Expire the previous day's label even while disconnected/asleep.
        TimelineView(.periodic(from: .now, by: 30)) { timeline in
            HStack(spacing: 8) {
                Image(systemName: "bolt.circle").foregroundStyle(.secondary)
                if let usage = store.usage, usage.isCurrent(at: timeline.date) {
                    Text("今日 (UTC) · \(usage.scopeLabel)").foregroundStyle(.secondary)
                    Text("\(usage.displayedNeurons.formatted(.number.precision(.fractionLength(0...2)))) Neurons")
                        .monospacedDigit()
                    if store.usageError != nil || !store.connected { Text("前回取得値").foregroundStyle(.secondary) }
                } else {
                    Text(store.usageLoading ? "使用量を取得中…" : "今日の使用量は未取得").foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
            }.font(.caption).padding(.horizontal, 12).padding(.bottom, 10)
        }
    }
}
