import SwiftUI

struct JournalStatisticsView: View {
    @ObservedObject var store: ChatStore
    private var detailVisible: Bool { store.journalUsageTarget != nil }
    private var loading: Bool { detailVisible ? store.journalUsageDetailLoading : store.journalUsageLoading }
    private var error: String? { detailVisible ? store.journalUsageDetailError : store.journalUsageError }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("日報エージェントの使用量").font(.title2.bold())
                    Spacer()
                    if loading { ProgressView().controlSize(.small) }
                    Button { refresh() } label: { Label("更新", systemImage: "arrow.clockwise") }
                        .disabled(!store.connected || loading)
                }
                Text("日報のAI推論だけを集計します。表示はセッション／ジョブの累計で、アカウント全体のNeuronsにも含まれます。")
                    .font(.caption).foregroundStyle(.secondary)
                if detailVisible {
                    HStack {
                        Button("セッション一覧へ") { store.closeJournalUsageDetail() }
                        if let detail = store.journalUsageDetail, detail.jobId != nil {
                            Button("セッション全体") { store.showJournalUsage(.session(detail.reportSessionId)) }
                                .disabled(!store.connected)
                        }
                    }
                    if let detail = store.journalUsageDetail {
                        detailContent(detail)
                    } else {
                        empty(loading ? "明細を取得中…" : "明細は未取得")
                    }
                } else if let page = store.journalUsage {
                    if page.sessions.isEmpty { empty("日報の使用量記録はまだありません") }
                    ForEach(page.sessions) { session in
                        Button { store.showJournalUsage(.session(session.id)) } label: {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    Text(session.started.formatted(date: .abbreviated, time: .shortened)).font(.headline)
                                    Spacer()
                                    Image(systemName: "chevron.right").foregroundStyle(.secondary)
                                }
                                if let summary = session.availableSummary {
                                    HStack {
                                        Text(amount(summary.confirmedTotal)).monospacedDigit()
                                        Text(summary.sourceLabel).font(.caption).foregroundStyle(.secondary)
                                    }
                                    if !summary.complete {
                                        Text("記録できた分: \(amount(summary.recordedNeurons))。総使用量は未確定です。")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                } else { Text("使用量を取得できませんでした").foregroundStyle(.secondary) }
                                Text("セッション \(session.id.prefix(8))").font(.caption).foregroundStyle(.secondary)
                            }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                                .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 12))
                                .contentShape(Rectangle())
                        }.buttonStyle(.plain).disabled(!store.connected)
                    }
                    if page.hasMore {
                        Button("以前のセッションを表示") { store.refreshJournalUsage(more: true) }
                            .disabled(!store.connected || loading)
                    }
                } else {
                    empty(loading ? "使用量を取得中…" : "バックエンドに接続して「更新」を押してください")
                }
                if let error { Text(error).font(.callout).foregroundStyle(.orange) }
                if !store.connected || error != nil {
                    Text("保存済みの表示値がある場合は、前回取得値です。").font(.caption).foregroundStyle(.secondary)
                }
            }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
        }
        .task { if store.connected { refresh() } }
        .onChange(of: store.connected) { _, connected in if connected { refresh() } }
    }
    @ViewBuilder private func detailContent(_ detail: JournalUsageDetail) -> some View {
        JournalUsageSummaryView(summary: detail.summary, job: detail.jobId != nil)
        Text(detail.jobId.map { "ジョブ \($0)" } ?? "セッション \(detail.reportSessionId)")
            .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
        Text("推論ごとの記録 · \(detail.attempts.count) / \(detail.summary.attempts) 件").font(.headline)
        ForEach(detail.attempts) { attempt in
            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("推論 \(attempt.round + 1) · \(attempt.statusLabel)").font(.headline)
                        Spacer()
                        Text(amount(attempt.neurons)).monospacedDigit()
                    }
                    Text(attempt.sourceLabel + (attempt.status == "completed" ? "" : " · 記録できた分のみ"))
                        .font(.caption).foregroundStyle(.secondary)
                    Text(attempt.model).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    HStack {
                        Text("入力 \(attempt.inputTokens.map(String.init) ?? "不明") / 出力 \(attempt.outputTokens.map(String.init) ?? "不明") tokens")
                        Spacer()
                        if let date = UsageSnapshot.parseDate(attempt.startedAt) {
                            Text(date.formatted(date: .omitted, time: .standard))
                        }
                    }.font(.caption).foregroundStyle(.secondary)
                    if detail.jobId == nil {
                        Button("ジョブ \(attempt.jobId.prefix(8)) の合計") { store.showJournalUsage(.job(attempt.jobId)) }
                            .disabled(!store.connected)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        if detail.hasMore {
            Button("さらに明細を表示") { store.refreshJournalUsageDetail(more: true) }
                .disabled(!store.connected || loading)
        }
    }
    private func refresh() {
        if detailVisible { store.refreshJournalUsageDetail() } else { store.refreshJournalUsage() }
    }
    private func empty(_ text: String) -> some View {
        ContentUnavailableView("日報の使用量", systemImage: "newspaper", description: Text(text))
            .frame(maxWidth: .infinity)
    }
    private func amount(_ value: Double?) -> String {
        value.map { "\($0.formatted(.number.precision(.fractionLength(0...4)))) Neurons" } ?? "不明"
    }
}
