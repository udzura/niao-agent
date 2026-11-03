import Foundation

enum JournalUsageTarget: Equatable {
    case session(String), job(String)
    var queryItem: URLQueryItem {
        switch self {
        case .session(let id): URLQueryItem(name: "reportSessionId", value: id)
        case .job(let id): URLQueryItem(name: "jobId", value: id)
        }
    }
    func matches(_ detail: JournalUsageDetail) -> Bool {
        switch self {
        case .session(let id): detail.reportSessionId == id && detail.jobId == nil
        case .job(let id): detail.jobId == id
        }
    }
}

struct JournalUsageSummary: Decodable {
    let attempts: Int
    let incompleteAttempts: Int
    let unmeasuredAttempts: Int
    let reportedAttempts: Int
    let estimatedAttempts: Int
    let reportedNeurons: Double
    let estimatedNeurons: Double
    let inputTokens: Int
    let outputTokens: Int
    let untrackedJobs: Int
    let complete: Bool
    let source: String
    let neurons: Double?
    let recordedNeurons: Double

    var confirmedTotal: Double? { complete ? neurons : nil }
    var sourceLabel: String {
        switch source {
        case "reported": "API返却値"
        case "estimated": "推定値"
        case "mixed": "返却値と推定値"
        case "no_inference": "推論なし"
        default: "使用量に不明分あり"
        }
    }
}

struct JournalUsageSession: Decodable, Identifiable {
    let reportSessionId: String
    let createdAt: Double
    let expiresAt: Double
    let status: String
    let trackingSince: String?
    let summary: JournalUsageSummary?
    var id: String { reportSessionId }
    var started: Date { Date(timeIntervalSince1970: createdAt / 1000) }
    var availableSummary: JournalUsageSummary? { status == "available" ? summary : nil }
}

struct JournalUsagePage: Decodable {
    let v: Int
    let sessions: [JournalUsageSession]
    let hasMore: Bool
    let nextCursor: Int?
    func appending(_ page: Self) -> Self {
        var ids = Set(sessions.map(\.id))
        return Self(v: page.v, sessions: sessions + page.sessions.filter { ids.insert($0.id).inserted },
                    hasMore: page.hasMore, nextCursor: page.nextCursor)
    }
}

struct JournalUsageAttempt: Decodable, Identifiable {
    let id: String
    let jobId: String
    let model: String
    let round: Int
    let startedAt: String
    let status: String
    let inputTokens: Int?
    let outputTokens: Int?
    let neurons: Double?
    let source: String
    var sourceLabel: String {
        switch source {
        case "reported": "API返却値"
        case "estimated": "推定値"
        default: "使用量不明"
        }
    }
    var statusLabel: String {
        switch status {
        case "completed": "完了"
        case "running": "実行中"
        case "interrupted": "中断"
        default: "状態不明"
        }
    }
}

struct JournalUsageDetail: Decodable {
    let v: Int
    let reportSessionId: String
    let jobId: String?
    let trackingSince: String
    let summary: JournalUsageSummary
    let attempts: [JournalUsageAttempt]
    let hasMore: Bool
    let nextCursor: Int?
    func appending(_ page: Self) throws -> Self {
        guard reportSessionId == page.reportSessionId, jobId == page.jobId else { throw NiaoError.protocolMismatch }
        var ids = Set(attempts.map(\.id))
        return Self(v: page.v, reportSessionId: reportSessionId, jobId: jobId, trackingSince: page.trackingSince,
                    summary: page.summary, attempts: attempts + page.attempts.filter { ids.insert($0.id).inserted },
                    hasMore: page.hasMore, nextCursor: page.nextCursor)
    }
}
