import SwiftUI

struct ToolStatisticsView: View {
    @ObservedObject var store: ChatStore
    @State private var selection = "current"
    private var session: ToolSession? { store.toolStatistics.sessions.first { $0.id == store.toolSessionID } }
    private var counts: [String: ToolCounts] { selection == "current" ? session?.tools ?? [:] : store.toolStatistics.totals }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("ツール実行の統計").font(.title2.bold())
            Picker("集計範囲", selection: $selection) {
                Text("今回のセッション").tag("current")
                Text("全体").tag("all")
            }.pickerStyle(.segmented)
            HStack(spacing: 32) {
                metric("呼び出し", counts.values.reduce(0) { $0 + $1.calls })
                metric("完了通知", counts.values.reduce(0) { $0 + $1.completed })
                metric("完了未確認", counts.values.reduce(0) { $0 + $1.unconfirmed })
            }
            if counts.isEmpty { Text("まだツール実行の記録はありません。").foregroundStyle(.secondary) }
            ForEach(counts.keys.sorted(), id: \.self) { name in
                HStack {
                    Text(name).font(.body.monospaced())
                    Spacer()
                    Text("\(counts[name]!.calls) 回 / 完了通知 \(counts[name]!.completed) 回").monospacedDigit()
                }
            }
            Divider()
            Text("セッションはアプリの起動から終了までです。再接続・スリープ復帰・チャット削除では区切りません。")
            if selection == "current", let session {
                Text("開始: \(session.startedAt.formatted(date: .abbreviated, time: .standard))")
            }
            if selection == "all" {
                Text("セッション別の記録").font(.headline)
                List(store.toolStatistics.sessions.reversed()) { item in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(item.startedAt.formatted(date: .abbreviated, time: .standard))
                            if item.id == store.toolSessionID { Text("今回のセッション").font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        Text("\(item.calls) 回 / 完了通知 \(item.completed) 回").monospacedDigit()
                    }
                }.frame(minHeight: 120)
            }
            Text("このMacで受信した通知のみを集計します。未接続中や導入前の実行は復元できません。「完了通知」はツール処理が戻った通知で、Rubyの成功を表すものではありません。接続先をまたいだ合計です。")
                .font(.caption).foregroundStyle(.secondary)
            if let error = store.toolStatisticsError { Text(error).foregroundStyle(.orange) }
            Spacer(minLength: 0)
        }.padding(24).frame(minWidth: 520, minHeight: 440)
    }
    private func metric(_ label: String, _ value: Int) -> some View {
        VStack(alignment: .leading) {
            Text(value.formatted()).font(.title).monospacedDigit()
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
    }
}
