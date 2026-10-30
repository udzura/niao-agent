import SwiftUI

struct PlatformStatisticsView: View {
    @ObservedObject var store: ChatStore
    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { timeline in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Text("Workersの利用状況").font(.title2.bold())
                        Spacer()
                        if store.platformUsageLoading { ProgressView().controlSize(.small) }
                        Button { store.refreshPlatformUsage() } label: { Label("更新", systemImage: "arrow.clockwise") }
                            .disabled(!store.connected || store.platformUsageLoading)
                    }
                    if let usage = store.platformUsage {
                        PlatformUsageContent(usage: usage, now: timeline.date)
                        if !store.connected || store.platformUsageError != nil {
                            Text("前回取得値を表示しています。").font(.caption).foregroundStyle(.secondary)
                        }
                    } else {
                        ContentUnavailableView("使用量は未取得", systemImage: "cloud", description: Text(
                            store.platformUsageLoading ? "使用量を取得しています。" : "バックエンドに接続して「更新」を押してください。"))
                    }
                    if let error = store.platformUsageError { Text(error).font(.callout).foregroundStyle(.orange) }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
        }.task { if store.connected { store.refreshPlatformUsage() } }
    }
}

struct PlatformUsageContent: View {
    let usage: PlatformUsageSnapshot
    var now = Date()
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(usage.isCurrent(at: now) ? "今日 (UTC) · アカウント全体" : "前回の集計日 · アカウント全体")
                .foregroundStyle(.secondary)
            GroupBox("契約プラン") {
                VStack(alignment: .leading, spacing: 8) {
                    Text(usage.plan.label).font(.headline)
                    if usage.plan.status != "available" {
                        Text("プランをAPIで確認できませんでした。下のグラフはFree枠を比較基準にしています。")
                            .font(.caption).foregroundStyle(.secondary)
                        if usage.plan.errorCode == "analytics_http_403" {
                            Text("プラン確認にはAnalyticsトークンに Account → Billing → Read 権限が必要です。")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if let code = usage.plan.errorCode { Text("診断: \(code)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                    } else if usage.plan.name == "paid" {
                        Text("Paidの利用枠は月次です。下のFree日次枠は比較用で、契約上の上限ではありません。")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("契約一覧に有効なWorkers有料契約がないことから判定しています。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Link("Cloudflareでプランを確認", destination: URL(string: "https://dash.cloudflare.com/?to=/:account/workers-and-pages")!)
                        .font(.caption)
                    if let date = usage.plan.queriedAt.flatMap(UsageSnapshot.parseDate) {
                        Text("プラン確認: \(date.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            PlatformBudgetCard(title: "Workers & Pages Functions", unit: "リクエスト", allowance: 100_000,
                               status: usage.workers.status, used: usage.workers.requests, errorCode: usage.workers.errorCode)
            PlatformBudgetCard(title: "Durable Objects · 課金対象持続時間", unit: "GB-s", allowance: 13_000,
                               status: usage.durableObjects.status, used: usage.durableObjects.durationGbSeconds,
                               errorCode: usage.durableObjects.errorCode)
            VStack(alignment: .leading, spacing: 8) {
                Text("UTC 0:00〜24:00（日本時間 9:00〜翌日 9:00）。Niao以外のアプリも含むアカウント全体の目安です。集計の遅延・サンプリングがあり、確定請求額や厳密な残量ではありません。")
                Text("Pagesの静的ファイルへのアクセスは含みません。GB-sは持続時間と割り当てメモリに基づく単位で、CPU実行時間とは異なります。")
                if let date = UsageSnapshot.parseDate(usage.asOf) {
                    Text("取得: \(date.formatted(date: .abbreviated, time: .standard))")
                }
                Text("利用量は最大60秒、プラン情報は最大1時間キャッシュします。")
            }.font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct PlatformBudgetCard: View {
    let title: String
    let unit: String
    let allowance: Double
    let status: String
    let used: Double?
    let errorCode: String?
    private var value: Double? {
        guard status == "available", let used, used.isFinite, used >= 0 else { return nil }
        return used
    }
    var body: some View {
        GroupBox(title) {
            VStack(alignment: .leading, spacing: 10) {
                if let value {
                    let fraction = value / allowance
                    let color: Color = fraction >= 0.9 ? .red : fraction >= 0.75 ? .orange : .accentColor
                    HStack(alignment: .firstTextBaseline) {
                        Text(value.formatted(.number.precision(.fractionLength(0...2))))
                            .font(.system(size: 28, weight: .semibold, design: .rounded)).monospacedDigit()
                        Text(unit).foregroundStyle(.secondary)
                        Spacer()
                        Text(fraction.formatted(.percent.precision(.fractionLength(1))))
                            .foregroundStyle(color).monospacedDigit()
                    }
                    ProgressView(value: min(1, fraction)).tint(color)
                        .accessibilityLabel("Free日次枠に対する利用量")
                    Text("Free日次枠: \(allowance.formatted()) \(unit)").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text(status == "not_configured" ? "Analyticsトークンが未設定です。" : "使用量を取得できませんでした。")
                        .foregroundStyle(.secondary)
                    if let errorCode { Text("診断: \(errorCode)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                }
            }.padding(.vertical, 4).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
