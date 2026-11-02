import SwiftUI
import Charts

struct ToolStatisticsView: View {
    @ObservedObject var store: ChatStore
    @Binding var selection: String
    private var session: ToolSession? { store.toolStatistics.sessions.first { $0.id == store.toolSessionID } }
    private var counts: [String: ToolCounts] { selection == "current" ? session?.tools ?? [:] : store.toolStatistics.totals }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("ツール実行の統計").font(.title2.bold())
                Picker("集計範囲", selection: $selection) {
                    Text("今回の起動").tag("current")
                    Text("全体").tag("all")
                }.pickerStyle(.segmented)
                HStack(spacing: 32) {
                    metric("呼び出し", counts.values.reduce(0) { $0 + $1.calls })
                    metric("完了通知", counts.values.reduce(0) { $0 + $1.completed })
                    metric("完了未確認", counts.values.reduce(0) { $0 + $1.unconfirmed })
                }
                if counts.isEmpty { Text("まだツール実行の記録はありません。").foregroundStyle(.secondary) }
                if !counts.isEmpty { ToolCallChart(counts: counts) }
                ForEach(counts.keys.sorted(), id: \.self) { name in
                    #if os(iOS)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(name).font(.body.monospaced()).textSelection(.enabled)
                        Text("\(counts[name]!.calls) 回 / 完了通知 \(counts[name]!.completed) 回")
                            .font(.caption).monospacedDigit().foregroundStyle(.secondary)
                    }
                    #else
                    HStack {
                        Text(name).font(.body.monospaced())
                        Spacer()
                        Text("\(counts[name]!.calls) 回 / 完了通知 \(counts[name]!.completed) 回").monospacedDigit()
                    }
                    #endif
                }
                Divider()
                Text("集計単位はアプリの起動から終了までです。会話のセッションとは別です。再接続・スリープ復帰・チャット削除では区切りません。")
                if selection == "current", let session {
                    Text("開始: \(session.startedAt.formatted(date: .abbreviated, time: .standard))")
                }
                if selection == "all" {
                    Text("起動別の記録").font(.headline)
                    if !store.toolStatistics.sessions.isEmpty {
                        SessionCallsChart(sessions: Array(store.toolStatistics.sessions.suffix(10)))
                    }
                    ForEach(store.toolStatistics.sessions.reversed()) { item in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(item.startedAt.formatted(date: .abbreviated, time: .standard))
                                if item.id == store.toolSessionID { Text("今回の起動").font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            Text("\(item.calls) 回 / 完了通知 \(item.completed) 回").monospacedDigit()
                        }.padding(.vertical, 4)
                    }
                }
                Text("この端末で受信した通知のみを集計します。未接続中や導入前の実行は復元できません。「完了通知」はツール処理が戻った通知で、ツール自体の成功を表すものではありません。接続先をまたいだ合計です。")
                    .font(.caption).foregroundStyle(.secondary)
                if let error = store.toolStatisticsError { Text(error).foregroundStyle(.orange) }
                Spacer(minLength: 0)
            }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 440)
        #endif
    }
    private func metric(_ label: String, _ value: Int) -> some View {
        VStack(alignment: .leading) {
            Text(value.formatted()).font(.title).monospacedDigit()
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
    }
}


struct ToolCallChart: View {
    let counts: [String: ToolCounts]
    private var names: [String] {
        counts.keys.sorted { counts[$0]!.calls == counts[$1]!.calls ? $0 < $1 : counts[$0]!.calls > counts[$1]!.calls }
    }
    private var maximum: Int { max(1, counts.values.map(\.calls).max() ?? 0) }
    var body: some View {
        GroupBox("ツール別の呼び出し回数") {
            Chart(names, id: \.self) { name in
                let count = counts[name]!
                BarMark(x: .value("回数", count.completed), y: .value("ツール", name))
                    .foregroundStyle(by: .value("通知", "完了通知あり"))
                    .accessibilityLabel("\(name)、完了通知あり")
                    .accessibilityValue("\(count.completed) 回")
                BarMark(x: .value("回数", count.unconfirmed), y: .value("ツール", name))
                    .foregroundStyle(by: .value("通知", "完了未確認"))
                    .annotation(position: .trailing, alignment: .leading) {
                        Text("\(count.calls)").font(.caption).monospacedDigit()
                    }
                    .accessibilityLabel("\(name)、完了未確認")
                    .accessibilityValue("\(count.unconfirmed) 回、合計 \(count.calls) 回")
            }
            .chartForegroundStyleScale(["完了通知あり": Color.accentColor, "完了未確認": Color.orange])
            .chartYScale(domain: names)
            .chartXScale(domain: 0...Double(maximum) * 1.2)
            .chartXAxis {
                AxisMarks(values: .stride(by: max(1, ceil(Double(maximum) / 5)))) {
                    AxisGridLine()
                    AxisValueLabel()
                }
            }
            .chartYAxis {
                AxisMarks { value in
                    AxisValueLabel {
                        if let name = value.as(String.self) {
                            Text(name).font(.caption).lineLimit(1).truncationMode(.middle)
                                #if os(iOS)
                                .frame(maxWidth: 115)
                                #endif
                        }
                    }
                }
            }
            .frame(height: CGFloat(max(1, names.count) * 42 + 55))
            .padding(8)
        }
    }
}

struct SessionCallsChart: View {
    let sessions: [ToolSession]
    var body: some View {
        GroupBox("直近10回の起動 · 呼び出し回数") {
            Chart(sessions) { session in
                BarMark(x: .value("起動", session.id.uuidString), y: .value("回数", session.calls))
                    .foregroundStyle(Color.accentColor)
                    .annotation(position: .top) { Text(session.calls.formatted()).font(.caption2).monospacedDigit() }
                    .accessibilityLabel(session.startedAt.formatted(date: .abbreviated, time: .shortened))
                    .accessibilityValue("\(session.calls) 回")
            }
            .chartXAxis {
                AxisMarks { value in
                    if let id = value.as(String.self), let session = sessions.first(where: { $0.id.uuidString == id }) {
                        AxisValueLabel {
                            Text("\((sessions.firstIndex(where: { $0.id == session.id }) ?? 0) + 1)")
                                .font(.caption2)
                        }
                    }
                }
            }
            .chartYScale(domain: 0...max(1, Double(sessions.map(\.calls).max() ?? 0) * 1.2))
            .chartYAxis {
                AxisMarks(values: .stride(by: max(1, ceil(Double(sessions.map(\.calls).max() ?? 0) / 4)))) {
                    AxisGridLine()
                    AxisValueLabel()
                }
            }
            .frame(height: 160).padding(8)
            Text("左から古い順。各起動の日時は下の一覧で確認できます。")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}
