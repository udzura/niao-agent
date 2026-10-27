import Foundation

// A live integration check using the exact URLSession transport compiled into Niao.
// It never prints the credential or conversation content.
@main
struct SmokeMain {
    static func main() async throws {
        let watchdog = Task {
            try await Task.sleep(for: .seconds(120))
            FileHandle.standardError.write(Data("FAIL: live smoke check timed out\n".utf8))
            exit(1)
        }
        defer { watchdog.cancel() }
        let env = ProcessInfo.processInfo.environment
        guard let token = env["NIAO_TOKEN"], token.count >= 32 else { throw NiaoError.configuration }
        let url = try BackendURL.validate(env["NIAO_BACKEND_URL"] ?? "http://127.0.0.1:8787")
        let backend = Backend(baseURL: url, token: token)
        let before = try await backend.history(after: 0)
        let ws = backend.socket()
        defer { ws.cancel(with: .normalClosure, reason: nil) }
        let ready = try await Backend.event(from: ws)
        guard ready.type == "ready", ready.v == 1 else { throw NiaoError.protocolMismatch }
        let id = CommandLine.arguments.dropFirst().first ?? UUID().uuidString.lowercased()
        let submission = Submission(requestId: id, content: "Reply with a short greeting in Japanese.")
        let data = try JSONEncoder().encode(submission)
        try await ws.send(.string(String(decoding: data, as: UTF8.self)))
        var partials = 0
        var completed: [ChatMessage] = []
        while completed.isEmpty {
            let event = try await Backend.event(from: ws)
            if event.type == "partial" { partials += 1 }
            if event.type == "error" { throw NSError(domain: "NiaoSmoke", code: 1, userInfo: [NSLocalizedDescriptionKey: event.code ?? "unknown"]) }
            if event.type == "committed" { completed = event.messages ?? [] }
        }
        guard completed.count == 2, completed[1].role == "assistant", !completed[1].content.isEmpty else { throw NiaoError.protocolMismatch }
        ws.cancel(with: .normalClosure, reason: nil)
        let after = try await backend.history(after: 0)
        guard after.messages.filter({ $0.requestId == id }).count == 2 else { throw NiaoError.protocolMismatch }
        let missed = try await backend.history(after: completed[0].seq)
        guard missed.messages.contains(where: { $0.id == completed[1].id }) else { throw NiaoError.protocolMismatch }
        let reconnected = backend.socket()
        defer { reconnected.cancel(with: .normalClosure, reason: nil) }
        _ = try await Backend.event(from: reconnected)
        try await reconnected.send(.string(String(decoding: data, as: UTF8.self)))
        while true {
            let event = try await Backend.event(from: reconnected)
            if event.type == "committed" {
                guard event.messages == completed else { throw NiaoError.protocolMismatch }
                break
            }
            if event.type == "error" { throw NiaoError.protocolMismatch }
        }
        print("PASS requestId=\(id) partials=\(partials) historyBefore=\(before.messages.count) historyAfter=\(after.messages.count) reconnect=ok idempotency=ok")
    }
}
