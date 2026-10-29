import SwiftUI

struct UsageView: View {
    @ObservedObject var store: ChatStore
    @State private var expanded = false
    var body: some View {
        // Expire the previous day's label even while disconnected/asleep.
        TimelineView(.periodic(from: .now, by: 30)) { timeline in
            VStack(alignment: .leading, spacing: 8) {
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
                    if store.usageLoading { ProgressView().controlSize(.mini) }
                    Button { store.refreshUsage() } label: { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.plain).disabled(!store.connected || store.usageLoading).help("使用量を更新")
                    Button { expanded.toggle() } label: { Image(systemName: expanded ? "chevron.up" : "info.circle") }
                        .buttonStyle(.plain).help("集計範囲と更新時刻")
                }
                if expanded {
                    if let usage = store.usage {
                        Text("UTC 0:00〜24:00（日本時間 9:00〜翌日 9:00）。アカウント集計には反映遅延があり、最大 60 秒キャッシュします。")
                        if let message = usage.configurationMessage { Text(message) }
                        if usage.accountAvailable {
                            Text("アカウント内の他のアプリ・モデルの使用量も含みます。確定請求額や残り利用可能量ではありません。")
                        }
                        Text("Niao 記録分: \(usage.local.neurons.formatted(.number.precision(.fractionLength(0...2)))) Neurons / \(usage.local.attempts) 回の呼び出し")
                        if let judge = usage.local.judge, judge.attempts > 0 {
                            Text("うちThinking判定: \(judge.neurons.formatted(.number.precision(.fractionLength(0...2)))) Neurons / \(judge.attempts) 回")
                            Text("判定の累計待ち時間: \((judge.totalDurationMs / 1000).formatted(.number.precision(.fractionLength(0...2)))) 秒")
                            if judge.timedAttempts > 0 {
                                Text("判定の平均待ち時間: \((judge.totalDurationMs / Double(judge.timedAttempts)).formatted(.number.precision(.fractionLength(0...0)))) ms")
                            }
                            if judge.calculatedAttempts > 0 {
                                Text("判定の使用量は公式レートによる換算値を含みます（Niao合計に加算済み）。")
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        if usage.local.unmeasuredAttempts > 0 {
                            Text("使用量未取得の呼び出し: \(usage.local.unmeasuredAttempts) 回（実行中・失敗・中断など）。記録値は総使用量を下回る場合があります。")
                        }
                        Text("Niao 記録分は記録機能の導入後のみ。他のアプリや導入前の利用は含みません。")
                        if let date = UsageSnapshot.parseDate(usage.account.queriedAt ?? usage.asOf) {
                            Text("取得: \(date.formatted(date: .abbreviated, time: .standard))")
                        }
                        if let date = usage.periodEnd {
                            Text("次の集計日: \(date.formatted(date: .abbreviated, time: .shortened))")
                        }
                    }
                    if let error = store.usageError { Text(error).foregroundStyle(.orange) }
                }
            }.font(.caption).padding(.horizontal, 12).padding(.bottom, 10)
        }
    }
}
