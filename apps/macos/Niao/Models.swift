import Foundation

struct ChatMessage: Codable, Identifiable, Equatable {
    let seq: Int
    let id: String
    let requestId: String
    let role: String
    let content: String
    let createdAt: String
}
struct Turn: Codable {
    let requestId: String
    let status: String
    let errorCode: String?
}
struct PartialMessage: Codable {
    let requestId: String
    let text: String
}
struct HistoryPage: Decodable {
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
    let active: PartialMessage?
}
struct Submission: Codable {
    var v = 1
    var type = "send"
    let requestId: String
    let content: String
    var epoch: Int? = nil
}
struct StoredSubmission: Codable {
    let backend: String
    let submission: Submission
}

enum NiaoError: LocalizedError {
    case configuration, unauthorized, api(String), http(Int), protocolMismatch, keychain(OSStatus)
    var errorDescription: String? {
        switch self {
        case .configuration: "HTTPS のバックエンド URL とトークンを設定してください。HTTP は localhost のみ使用できます。"
        case .unauthorized: "認証に失敗しました。設定のトークンを確認してください。"
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

func explanation(_ code: String) -> String {
    switch code {
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
        let neurons: Double
        let attempts: Int
        let unmeasuredAttempts: Int
        let trackingSince: String
    }
    let v: Int
    let dayStart: String
    let dayEnd: String
    let asOf: String
    let account: Account
    let local: Local

    var accountAvailable: Bool { account.status == "available" && account.neurons != nil }
    var displayedNeurons: Double { accountAvailable ? account.neurons! : local.neurons }
    var scopeLabel: String { accountAvailable ? "アカウント全体" : "Niao 記録分" }
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

struct AgentSettings: Decodable {
    struct Model: Decodable, Identifiable { let id: String; let name: String }
    let v: Int
    let modelId: String
    let epoch: Int
    let models: [Model]
}
struct ClearHistoryResult: Decodable { let v: Int; let epoch: Int }
