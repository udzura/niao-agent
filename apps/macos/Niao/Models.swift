import Foundation

struct ThinkingSegment: Codable, Identifiable, Equatable {
    let generation: Int
    let text: String
    let active: Bool
    var id: Int { generation }
}
struct ChatMessage: Codable, Identifiable, Equatable {
    let seq: Int
    let id: String
    let requestId: String
    let role: String
    let content: String
    let createdAt: String
    var thinking: [ThinkingSegment]? = nil
}
struct Turn: Codable {
    let requestId: String
    let status: String
    let errorCode: String?
    var errorDetails: AIErrorDetails? = nil
}
struct AIErrorDetails: Codable, Equatable {
    let provider: String
    let reason: String
    let message: String
    let providerCode: Int?
    let httpStatus: Int?
    let retryAt: String?
}
struct PartialMessage: Codable {
    let requestId: String
    let text: String
    var thinking: [ThinkingSegment]? = nil
}
struct BackgroundJob: Codable, Identifiable, Equatable {
    var sessionId: String? = nil
    let id: String
    let kind: String
    let title: String
    let status: String
    let dueAt: String?
    var scheduledDate: Date? {
        guard let dueAt else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: dueAt) ?? ISO8601DateFormatter().date(from: dueAt)
    }
    var label: String { kind == "reminder" ? "リマインダー" : kind == "web_fetch" ? "記事の取得" : "バックグラウンド処理" }
    var icon: String { kind == "reminder" ? "bell" : "doc.text.magnifyingglass" }
    var statusLabel: String {
        switch status {
        case "pending": "受付済み"
        case "queued": "実行待ち"
        case "running": "取得中"
        case "ready": "通知待ち"
        case "notifying": "要約を生成中"
        case "retry_wait": "通知の再試行待ち"
        case "scheduled": "予約済み"
        default: "処理中"
        }
    }
}
struct BackgroundJobsSnapshot: Codable, Equatable {
    let revision: Int
    let items: [BackgroundJob]
    // HTTP replies and buffered socket events may arrive in reverse order.
    func accepting(_ incoming: Self) -> Self { incoming.revision >= revision ? incoming : self }
}
struct HistoryPage: Decodable {
    var sessionId: String? = nil
    var sessions: SessionCatalog? = nil
    var hasOlder: Bool? = nil
    var beforeCursor: Int? = nil
    var jobs: BackgroundJobsSnapshot? = nil
    let epoch: Int?
    let settings: AgentSettings?
    let v: Int
    let messages: [ChatMessage]
    let cursor: Int
    let hasMore: Bool
    let turns: [Turn]
    let active: PartialMessage?
}
struct ServerEvent: Decodable {
    var sessionId: String? = nil
    var sessions: SessionCatalog? = nil
    var jobs: BackgroundJobsSnapshot? = nil
    let thinking: [ThinkingSegment]?
    let name: String?
    let status: String?
    let epoch: Int?
    let settings: AgentSettings?
    let v: Int?
    let type: String
    let requestId: String?
    let message: ChatMessage?
    let messages: [ChatMessage]?
    let text: String?
    let code: String?
    let details: AIErrorDetails?
    let active: PartialMessage?
}
struct Submission: Codable {
    var v = 1
    var type = "send"
    var sessionId: String? = nil
    let requestId: String
    let content: String
    var epoch: Int? = nil
}
struct ChatSession: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let createdAt: String
    let updatedAt: String
    let lastActivityAt: String
    let archivedAt: String?
    let epoch: Int
    let messageCount: Int?
}
struct SessionCatalog: Codable, Equatable {
    let revision: Int
    let retentionDays: Int
    let maxSessions: Int
    let activeSessionId: String?
    let items: [ChatSession]
    func accepting(_ incoming: Self) -> Self { incoming.revision >= revision ? incoming : self }
}
struct SessionsResponse: Decodable {
    let v: Int
    let sessions: SessionCatalog
    var jobs: BackgroundJobsSnapshot? = nil
    var session: ChatSession? = nil
}
struct StoredOutboxes: Codable {
    let backend: String
    let submissions: [String: Submission]
}
struct StoredSubmission: Codable {
    let backend: String
    let submission: Submission
}

enum NiaoError: LocalizedError {
    case configuration, unauthorized, authentication(String), api(String), http(Int), protocolMismatch, keychain(OSStatus)
    var errorDescription: String? {
        switch self {
        case .configuration: "HTTPS のバックエンド URL とトークンを設定してください。HTTP は localhost のみ使用できます。"
        case .unauthorized: "認証に失敗しました。設定のトークンを確認してください。"
        case .authentication(let message): message
        case .api(let code): explanation(code)
        case .http(let code): "サーバーに接続できません (HTTP \(code))。"
        case .protocolMismatch: "サーバーの通信形式を確認してください。"
        case .keychain(let code): "Keychain にアクセスできません (\(code))。"
        }
    }
}

enum BackendURL {
    static func validate(_ value: String) throws -> URL {
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, ["", "/"].contains(url.path),
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host))
        else { throw NiaoError.configuration }
        return url
    }
}

func mergeMessages(_ existing: [ChatMessage], _ incoming: [ChatMessage]) -> [ChatMessage] {
    var byID = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
    for message in incoming { byID[message.id] = message }
    return byID.values.sorted { $0.seq < $1.seq }
}

func explanation(_ code: String, details: AIErrorDetails? = nil) -> String {
    if let details, details.provider == "cloudflare" {
        let message: String
        switch details.reason {
        case "daily_quota_exceeded": message = "Workers AI の1日10,000 Neuronsの無料枠に達しました。毎日 UTC 0:00（日本時間9:00）にリセットされます。"
        case "capacity_exceeded": message = "Workers AI が一時的に混雑しています。時間を置いて再試行してください。"
        case "rate_limited": message = "Workers AI のリクエスト制限に達しました。時間を置いて再試行してください。"
        case "paid_plan_required": message = "このモデルには Workers Paid プランが必要です。モデルまたはプランを確認してください。"
        case "access_denied": message = "Workers AI へのアクセスが拒否されました。アカウントの権限やモデルの利用条件を確認してください。"
        case "timeout": message = "Workers AI の応答がタイムアウトしました。時間を置いて再試行してください。"
        default: message = explanation(code)
        }
        let codes = [details.httpStatus.map { "HTTP \($0)" }, details.providerCode.map { "Cloudflare \($0)" }].compactMap { $0 }
        return codes.isEmpty ? message : message + "\n" + codes.joined(separator: " / ")
    }
    return switch code {
    case "session_not_found": "この会話は削除されたか、保持期限が過ぎています。会話一覧から選び直してください。"
    case "session_limit": "会話数の上限に達しました。不要な会話を削除してください。"
    case "session_full": "この会話の保存量が上限に達しました。新しい会話を始めてください。"
    case "protocol_mismatch": "複数会話に対応したサーバーとアプリを使用してください。"
    case "tool_limit": "ツールの実行回数上限に達しました。処理を小さく分けてお試しください。"
    case "invalid_tool_call": "AIが返したツール呼び出しを処理できませんでした。"
    case "unsupported_model": "このモデルは選択できません。サーバーのモデル一覧を確認してください。"
    case "history_changed": "会話履歴が削除・更新されています。再同期してから操作してください。"
    case "precondition_required": "履歴を同期してから削除してください。"
    case "ai_rate_limited": "AI の利用制限に達しました。時間を置いて再試行してください。"
    case "ai_timeout": "AI の応答がタイムアウトしました。再試行できます。"
    case "interrupted", "incomplete_ai_stream": "応答が途中で中断されました。再試行できます。"
    case "busy": "別の応答を生成しています。完了後に再試行してください。"
    case "id_conflict": "送信 ID が異なる内容に使われています。設定を確認してください。"
    case "invalid_message": "空のメッセージや 8,000 UTF-16 文字を超える入力は送信できません。"
    default: "AI の応答を取得できませんでした (\(code))。再試行できます。"
    }
}

struct UsageSnapshot: Decodable {
    struct Account: Decodable {
        let status: String
        let neurons: Double?
        let queriedAt: String?
        let errorCode: String?
    }
    struct Local: Decodable {
        struct Judge: Decodable {
            let neurons: Double
            let attempts: Int
            let unmeasuredAttempts: Int
            let calculatedAttempts: Int
            let totalDurationMs: Double
            let timedAttempts: Int
        }
        let neurons: Double
        let attempts: Int
        let unmeasuredAttempts: Int
        let trackingSince: String
        let judge: Judge?
    }
    let v: Int
    let dayStart: String
    let dayEnd: String
    let asOf: String
    let account: Account
    let local: Local

    var accountAvailable: Bool { account.status == "available" && account.neurons != nil }
    var displayedNeurons: Double { accountAvailable ? account.neurons! : local.neurons }
    var scopeLabel: String { accountAvailable ? "アカウント全体" : (local.judge?.calculatedAttempts ?? 0) > 0 ? "Niao 記録・換算分" : "Niao 記録分" }
    static func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    var periodEnd: Date? { Self.parseDate(dayEnd) }
    func isCurrent(at date: Date = Date()) -> Bool {
        guard let start = Self.parseDate(dayStart), let end = periodEnd else { return false }
        return start <= date && date < end
    }
    var configurationMessage: String? {
        switch account.status {
        case "not_configured": "アカウント全体を表示するには、サーバーに Analytics 読み取り用トークンを設定してください。"
        case "unavailable": "アカウント全体の使用量を取得できません。権限・設定・接続を確認してください。"
        default: nil
        }
    }
}

struct PlatformUsageSnapshot: Decodable {
    struct Workers: Decodable {
        let status: String
        let requests: Double?
        let queriedAt: String?
        let errorCode: String?
    }
    struct DurableObjects: Decodable {
        let status: String
        let durationGbSeconds: Double?
        let queriedAt: String?
        let errorCode: String?
    }
    struct Plan: Decodable {
        let status: String
        let name: String?
        let queriedAt: String?
        let errorCode: String?
        var label: String {
            guard status == "available" else { return "未確認" }
            switch name { case "free": return "Workers Free"; case "paid": return "Workers Paid"; default: return "未確認" }
        }
    }
    let v: Int
    let dayStart: String
    let dayEnd: String
    let asOf: String
    let workers: Workers
    let durableObjects: DurableObjects
    let plan: Plan
    func isCurrent(at date: Date = Date()) -> Bool {
        guard let start = UsageSnapshot.parseDate(dayStart), let end = UsageSnapshot.parseDate(dayEnd) else { return false }
        return start <= date && date < end
    }
}

enum ThinkingMode: String, Codable, CaseIterable, Identifiable {
    case automatic = "auto", on, off
    var id: String { rawValue }
    var label: String {
        switch self { case .automatic: "自動"; case .on: "常にON"; case .off: "常にOFF" }
    }
}
struct ThinkingPolicy: Codable, Equatable {
    var offThreshold: Double
    var onThreshold: Double
    var ambiguity: String
    var timeoutMs: Int
    static let standard = ThinkingPolicy(offThreshold: 0.35, onThreshold: 0.65, ambiguity: "on", timeoutMs: 3000)
}

enum ThinkingChoice: String, CaseIterable, Identifiable {
    case automaticSelective, automatic, automaticFrequent, on, off, custom
    var id: String { rawValue }
    var label: String {
        switch self {
        case .automaticSelective: "自動（控えめ）"
        case .automatic: "自動（標準）"
        case .automaticFrequent: "自動（多め）"
        case .on: "常にON"
        case .off: "常にOFF"
        case .custom: "自動（カスタム）"
        }
    }
    private var thresholds: (Double, Double)? {
        switch self {
        case .automaticSelective: (0.65, 0.85)
        case .automatic: (0.35, 0.65)
        case .automaticFrequent: (0.15, 0.45)
        default: nil
        }
    }
    static func current(mode: ThinkingMode, policy: ThinkingPolicy) -> Self {
        if mode == .on { return .on }
        if mode == .off { return .off }
        return allCases.first { choice in
            guard let (off, on) = choice.thresholds else { return false }
            return policy.offThreshold == off && policy.onThreshold == on && policy.ambiguity == "on"
        } ?? .custom
    }
    func update(using policy: ThinkingPolicy) -> ModelSettingsUpdate {
        if let (off, on) = thresholds {
            var next = policy
            next.offThreshold = off; next.onThreshold = on; next.ambiguity = "on"
            return ModelSettingsUpdate(thinkingMode: .automatic, thinkingPolicy: next)
        }
        // Manual modes retain the last automatic policy for the next switch back.
        return ModelSettingsUpdate(thinkingMode: self == .on ? .on : self == .off ? .off : .automatic)
    }
}
struct AgentSettings: Decodable {
    let serverVersion: String?
    struct Model: Decodable, Identifiable {
        let id: String
        let name: String
        let supportsThinking: Bool?
    }
    let v: Int
    let modelId: String
    let thinkingMode: ThinkingMode
    let thinkingPolicy: ThinkingPolicy
    var thinkingChoice: ThinkingChoice { .current(mode: thinkingMode, policy: thinkingPolicy) }
    var thinkingEnabled: Bool { thinkingMode == .on }
    let epoch: Int
    let models: [Model]
    private enum CodingKeys: String, CodingKey { case v, modelId, thinkingMode, thinkingPolicy, thinkingEnabled, epoch, models, serverVersion }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        serverVersion = try values.decodeIfPresent(String.self, forKey: .serverVersion)
        v = try values.decode(Int.self, forKey: .v)
        modelId = try values.decode(String.self, forKey: .modelId)
        if let mode = try values.decodeIfPresent(ThinkingMode.self, forKey: .thinkingMode) { thinkingMode = mode }
        else { thinkingMode = try values.decodeIfPresent(Bool.self, forKey: .thinkingEnabled) == true ? .on : .off }
        thinkingPolicy = try values.decodeIfPresent(ThinkingPolicy.self, forKey: .thinkingPolicy) ?? .standard
        epoch = try values.decode(Int.self, forKey: .epoch)
        models = try values.decode([Model].self, forKey: .models)
    }
}
struct ModelSettingsUpdate: Encodable {
    var modelId: String? = nil
    var thinkingMode: ThinkingMode? = nil
    var thinkingPolicy: ThinkingPolicy? = nil
}
struct ClearHistoryResult: Decodable { let v: Int; let epoch: Int }

struct HistoryLoadState: Equatable {
    enum Phase: Equatable { case idle, loading, loaded, failed(String) }
    private(set) var phase: Phase = .idle
    private var request: UUID?
    var isLoading: Bool { phase == .loading }
    var error: String? { if case .failed(let message) = phase { message } else { nil } }
    mutating func begin() -> UUID {
        let id = UUID(); request = id; phase = .loading; return id
    }
    mutating func finish(_ id: UUID) {
        guard request == id else { return }
        request = nil; phase = .loaded
    }
    mutating func fail(_ id: UUID, message: String) {
        guard request == id else { return }
        request = nil; phase = .failed(message)
    }
    mutating func reset() { request = nil; phase = .idle }
}
