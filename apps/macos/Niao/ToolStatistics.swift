import Foundation

struct ToolCounts: Codable {
    var calls = 0
    var completed = 0
    var unconfirmed: Int { max(0, calls - completed) }
}
struct ToolSession: Codable, Identifiable {
    var id = UUID()
    var startedAt = Date()
    var lastObservedAt: Date?
    var tools: [String: ToolCounts] = [:]
    var calls: Int { tools.values.reduce(0) { $0 + $1.calls } }
    var completed: Int { tools.values.reduce(0) { $0 + $1.completed } }
}
struct ToolStatistics: Codable {
    var version = 1
    var sessions: [ToolSession] = []
    // Event identity is unavailable on legacy servers. Pair start/end notifications
    // within a turn; do not deduplicate by requestId alone (several calls per turn).
    private var completedKeys: Set<String> = []
    private var pending: [String: UUID] = [:]
    enum CodingKeys: String, CodingKey { case version, sessions }
    var totals: [String: ToolCounts] {
        var result: [String: ToolCounts] = [:]
        for session in sessions {
            for (name, count) in session.tools {
                result[name, default: ToolCounts()].calls += count.calls
                result[name, default: ToolCounts()].completed += count.completed
            }
        }
        return result
    }
    mutating func beginSession(at date: Date = Date()) -> UUID {
        pending.removeAll()
        completedKeys.removeAll()
        var session = ToolSession()
        session.startedAt = date
        sessions.append(session)
        return session.id
    }
    mutating func observe(sessionID: UUID, backend: String, epoch: Int, requestID: String,
                          name: String, status: String, at date: Date = Date()) {
        guard !name.isEmpty, name.utf8.count <= 128, ["running", "completed"].contains(status),
              let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return }
        let key = identity(backend, epoch, requestID, name)
        if status == "running" {
            guard pending[key] == nil else { return }
            completedKeys.remove(key)
            pending[key] = sessionID
            sessions[index].tools[name, default: ToolCounts()].calls += 1
        } else {
            guard !completedKeys.contains(key) else { return }
            completedKeys.insert(key)
            // Completion alone still proves a call happened, even if start was missed.
            if pending.removeValue(forKey: key) == nil {
                sessions[index].tools[name, default: ToolCounts()].calls += 1
            }
            sessions[index].tools[name, default: ToolCounts()].completed += 1
        }
        sessions[index].lastObservedAt = date
    }
    mutating func finishTurn(backend: String, epoch: Int, requestID: String) {
        let prefix = turnIdentity(backend, epoch, requestID) + "|"
        pending = pending.filter { !$0.key.hasPrefix(prefix) }
    }
    private func identity(_ backend: String, _ epoch: Int, _ request: String, _ name: String) -> String {
        // Length-prefixed components avoid collisions, without persisting identifiers.
        turnIdentity(backend, epoch, request) + "|\(name.utf8.count):\(name)"
    }
    private func turnIdentity(_ backend: String, _ epoch: Int, _ request: String) -> String {
        [backend, String(epoch), request].map { "\($0.utf8.count):\($0)" }.joined(separator: "|")
    }
    static func load(from url: URL) throws -> ToolStatistics {
        guard FileManager.default.fileExists(atPath: url.path) else { return ToolStatistics() }
        let value = try JSONDecoder().decode(ToolStatistics.self, from: Data(contentsOf: url))
        guard value.version == 1 else { throw CocoaError(.fileReadCorruptFile) }
        return value
    }
    func save(to url: URL) throws {
        try JSONEncoder().encode(self).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
