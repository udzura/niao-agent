import SwiftUI

struct JournalUsageSummaryView: View {
    let summary: JournalUsageSummary
    let job: Bool
    var body: some View {
        GroupBox(job ? "このジョブの累計" : "このセッションの累計") {
            VStack(alignment: .leading, spacing: 10) {
                Text(summary.confirmedTotal.map { "\(number($0)) Neurons" } ?? "総使用量は不明")
                    .font(.title.bold()).monospacedDigit()
                Text(summary.sourceLabel).font(.callout).foregroundStyle(.secondary)
                if !summary.complete {
                    LabeledContent("記録できた分", value: "\(number(summary.recordedNeurons)) Neurons")
                    Text("実行中・未取得・中断などの不明分があるため、記録値は総使用量を下回る場合があります。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                LabeledContent("API返却値の合計", value: "\(number(summary.reportedNeurons)) Neurons")
                LabeledContent("推定値の合計", value: "\(number(summary.estimatedNeurons)) Neurons")
                LabeledContent("推論回数", value: "\(summary.attempts) 回")
                LabeledContent("入力／出力", value: "\(summary.inputTokens) / \(summary.outputTokens) tokens")
                if summary.incompleteAttempts > 0 { LabeledContent("実行中・中断", value: "\(summary.incompleteAttempts) 回") }
                if summary.unmeasuredAttempts > 0 { LabeledContent("使用量未取得", value: "\(summary.unmeasuredAttempts) 回") }
                if summary.untrackedJobs > 0 { LabeledContent("記録機能の導入前", value: "\(summary.untrackedJobs) ジョブ") }
                if summary.estimatedAttempts > 0 {
                    Text("推定値はトークン数と公式単価から換算しています。請求の確定値ではありません。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func number(_ value: Double) -> String { value.formatted(.number.precision(.fractionLength(0...4))) }
}
