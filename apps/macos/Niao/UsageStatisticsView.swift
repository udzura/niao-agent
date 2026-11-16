import SwiftUI

struct UsageStatisticsView: View {
    @ObservedObject var store: ChatStore
    @State private var selection = "neurons"
    @State private var toolSelection = "current"
    var body: some View {
        VStack(spacing: 0) {
            Picker("統計の種類", selection: $selection) {
                Text("Neurons").tag("neurons")
                Text("OpenAI").tag("openai")
                Text("日報").tag("journal")
                Text("Workers").tag("workers")
                Text("ツール").tag("tools")
            }.pickerStyle(.segmented).labelsHidden().padding(.horizontal, 24).padding(.top, 20)
            if selection == "neurons" { NeuronStatisticsView(store: store) }
            else if selection == "openai" { OpenAIStatisticsView(store: store) }
            else if selection == "journal" { JournalStatisticsView(store: store) }
            else if selection == "workers" { PlatformStatisticsView(store: store) }
            else { ToolStatisticsView(store: store, selection: $toolSelection) }
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 520)
        #endif
    }
}

private struct OpenAIStatisticsView: View {
    @ObservedObject var store: ChatStore

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { timeline in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Text("OpenAI の利用状況").font(.title2.bold())
                        Spacer()
                        if store.openAIUsageLoading { ProgressView().controlSize(.small) }
                        Button { store.refreshOpenAIUsage() } label: { Label("更新", systemImage: "arrow.clockwise") }
                            .disabled(!store.connected || store.openAIUsageLoading)
                    }
                    if let usage = store.openAIUsage {
                        let previous = !usage.isCurrent(at: timeline.date) || !store.connected || store.openAIUsageError != nil
                        Text("\(previous ? "前回取得分" : "今日") · \(usage.date)（JST）").foregroundStyle(.secondary)
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(usage.totals.totalTokens.formatted()).font(.largeTitle.bold()).monospacedDigit()
                            Text("tokens（記録済み合計）").foregroundStyle(.secondary)
                        }
                        GroupBox("Niao の記録分") {
                            VStack(alignment: .leading, spacing: 8) {
                                LabeledContent("入力", value: usage.totals.inputTokens.formatted())
                                LabeledContent("出力", value: usage.totals.outputTokens.formatted())
                                LabeledContent("推論回数", value: "\(usage.totals.attempts.formatted()) 回")
                                if usage.totals.unmeasuredAttempts > 0 {
                                    LabeledContent("トークン数未取得・一部取得", value: "\(usage.totals.unmeasuredAttempts.formatted()) 回")
                                }
                                if usage.journalUnavailableSessions > 0 {
                                    LabeledContent("未取得の日報セッション", value: usage.journalUnavailableSessions.formatted())
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading).monospacedDigit()
                        }
                        if !usage.models.isEmpty {
                            GroupBox("モデル別") {
                                VStack(alignment: .leading, spacing: 10) {
                                    ForEach(usage.models) { model in
                                        LabeledContent {
                                            Text(model.totalTokens.formatted()).monospacedDigit()
                                        } label: {
                                            VStack(alignment: .leading, spacing: 3) {
                                                Text(model.modelId)
                                                Text("入力 \(model.inputTokens.formatted()) / 出力 \(model.outputTokens.formatted())")
                                                    .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                                            }
                                        }
                                    }
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        Text("日本時間 0:00 からの、Niao のチャット・バックグラウンド要約・日報の使用量です。")
                            .font(.caption).foregroundStyle(.secondary)
                        if let tracked = UsageSnapshot.parseDate(usage.chatTrackingSince),
                           let dayStart = UsageSnapshot.parseDate(usage.dayStart), tracked > dayStart {
                            Text("チャットと要約は、この機能の導入後の分を表示しています。")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    } else {
                        ContentUnavailableView("使用量は未取得", systemImage: "chart.bar.xaxis",
                                               description: Text(store.openAIUsageLoading ? "使用量を取得しています。" : "接続後に使用量を更新してください。"))
                    }
                    if let error = store.openAIUsageError { Text(error).font(.callout).foregroundStyle(.orange) }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
        }.task(id: store.connected) { if store.connected { store.refreshOpenAIUsage() } }
    }
}
