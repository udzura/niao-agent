import SwiftUI

struct NeuronStatisticsView: View {
    @ObservedObject var store: ChatStore
    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { timeline in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Text("Neuronsの利用状況").font(.title2.bold())
                        Spacer()
                        if store.usageLoading { ProgressView().controlSize(.small) }
                        Button { store.refreshUsage() } label: { Label("更新", systemImage: "arrow.clockwise") }
                            .disabled(!store.connected || store.usageLoading)
                    }
                    if let usage = store.usage {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(usage.isCurrent(at: timeline.date) ? "今日 (UTC) · \(usage.scopeLabel)" : "前回取得分 · \(usage.scopeLabel)")
                                .foregroundStyle(.secondary)
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(neurons(usage.displayedNeurons)).font(.largeTitle.bold()).monospacedDigit()
                                Text("Neurons").foregroundStyle(.secondary)
                            }
                            if store.usageError != nil || !store.connected {
                                Text("前回取得値を表示しています。").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        NeuronBudgetChart(used: usage.displayedNeurons, accountAvailable: usage.accountAvailable,
                                          current: usage.isCurrent(at: timeline.date))
                        if let message = usage.configurationMessage { Text(message).font(.callout).foregroundStyle(.secondary) }
                        if usage.accountAvailable {
                            Text("アカウント内の他のアプリ・モデルの使用量も含みます。確定請求額や残り利用可能量ではありません。")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        GroupBox("Niao 記録分") {
                            VStack(alignment: .leading, spacing: 8) {
                                LabeledContent("使用量", value: "\(neurons(usage.local.neurons)) Neurons")
                                LabeledContent("呼び出し", value: "\(usage.local.attempts) 回")
                                if usage.local.unmeasuredAttempts > 0 {
                                    LabeledContent("使用量未取得", value: "\(usage.local.unmeasuredAttempts) 回")
                                    Text("実行中・失敗・中断などの使用量は未取得です。記録値は総使用量を下回る場合があります。")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                if let judge = usage.local.judge, usage.local.neurons > 0 {
                                    let share = min(1, max(0, judge.neurons / usage.local.neurons))
                                    VStack(alignment: .leading, spacing: 4) {
                                        HStack {
                                            Text("Thinking判定の割合")
                                            Spacer()
                                            Text(share.formatted(.percent.precision(.fractionLength(1)))).monospacedDigit()
                                        }.font(.caption)
                                        ProgressView(value: share).tint(.purple)
                                            .accessibilityLabel("Niao記録分に占めるThinking判定の割合")
                                    }
                                }
                                Text("記録機能の導入後のみ。他のアプリや導入前の利用は含みません。")
                                    .font(.caption).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if let judge = usage.local.judge, judge.attempts > 0 {
                            GroupBox("Thinking判定 · Clef-flash") {
                                VStack(alignment: .leading, spacing: 8) {
                                    LabeledContent("使用量（Niao合計の内訳）", value: "\(neurons(judge.neurons)) Neurons")
                                    LabeledContent("判定回数", value: "\(judge.attempts) 回")
                                    LabeledContent("累計待ち時間", value: "\((judge.totalDurationMs / 1000).formatted(.number.precision(.fractionLength(0...2)))) 秒")
                                    if judge.timedAttempts > 0 {
                                        LabeledContent("平均待ち時間", value: "\((judge.totalDurationMs / Double(judge.timedAttempts)).formatted(.number.precision(.fractionLength(0...0)))) ms")
                                    }
                                    if judge.unmeasuredAttempts > 0 {
                                        LabeledContent("使用量未取得", value: "\(judge.unmeasuredAttempts) 回")
                                    }
                                    if judge.calculatedAttempts > 0 {
                                        Text("公式レートによる換算値を含みます。Niao合計に加算済みです。")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        Divider()
                        VStack(alignment: .leading, spacing: 8) {
                            Text("UTC 0:00〜24:00（日本時間 9:00〜翌日 9:00）。アカウント集計には反映遅延があり、最大60秒キャッシュします。")
                            if let date = UsageSnapshot.parseDate(usage.account.queriedAt ?? usage.asOf) {
                                Text("取得: \(date.formatted(date: .abbreviated, time: .standard))")
                            }
                            if let date = usage.periodEnd {
                                Text("次の集計日: \(date.formatted(date: .abbreviated, time: .shortened))")
                            }
                        }.font(.caption).foregroundStyle(.secondary)
                    } else {
                        ContentUnavailableView("使用量は未取得", systemImage: "bolt.circle", description: Text(emptyDescription))
                            .frame(maxWidth: .infinity)
                    }
                    if let error = store.usageError { Text(error).font(.callout).foregroundStyle(.orange) }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
        }.task { if store.connected { store.refreshUsage() } }
    }
    private var emptyDescription: String {
        if store.usageLoading { return "使用量を取得しています。" }
        return store.connected ? "「更新」から使用量を取得してください。" : "バックエンドに接続して使用量を更新してください。"
    }
    private func neurons(_ value: Double) -> String { value.formatted(.number.precision(.fractionLength(0...2))) }
}


struct NeuronBudgetChart: View {
    let used: Double
    let accountAvailable: Bool
    let current: Bool
    private let allowance: Double = 10_000
    private var fraction: Double { max(0, used) / allowance }
    private var color: Color { fraction >= 0.9 ? .red : fraction >= 0.75 ? .orange : .accentColor }
    var body: some View {
        GroupBox("1日の無料枠 · 10,000 Neurons") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    Text(fraction.formatted(.percent.precision(.fractionLength(1))))
                        .font(.system(size: 32, weight: .semibold, design: .rounded)).monospacedDigit()
                        .foregroundStyle(color)
                    Text(accountAvailable ? "使用済み" : "Niao記録分のみ").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                }
                Gauge(value: min(1, fraction), in: 0...1) { Text("無料枠に対する使用率") }
                    .gaugeStyle(.linearCapacity).tint(color)
                    .accessibilityValue(fraction.formatted(.percent.precision(.fractionLength(1))))
                HStack {
                    Text("0")
                    Spacer()
                    Text("10,000 Neurons")
                }.font(.caption).foregroundStyle(.secondary)
                if accountAvailable {
                    LabeledContent(used > allowance ? "無料枠を超えた量" : "無料枠の残り（目安）",
                                   value: "\(abs(allowance - used).formatted(.number.precision(.fractionLength(0...2)))) Neurons")
                        .font(.callout).monospacedDigit()
                } else {
                    Text("アカウント全体が未取得のため、全体の残量は算出できません。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if !current {
                    Text("前回の集計日の値です。今日の残量ではありません。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text("無料枠を基準にした比較です。Paidプランの利用上限ではありません。")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(6).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
