import Foundation

// Never follow a redirect carrying the personal credential to another origin.
final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

final class Backend {
    private let baseURL: URL
    private let token: String
    private let session: URLSession
    init(baseURL: URL, token: String) {
        self.baseURL = baseURL
        self.token = token
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        config.httpCookieStorage = nil
        config.urlCache = nil
        session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    private func request(path: String, websocket: Bool = false) -> URLRequest {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        let parts = path.split(separator: "?", maxSplits: 1)
        components.path = String(parts[0])
        components.percentEncodedQuery = parts.count > 1 ? String(parts[1]) : nil
        if websocket { components.scheme = baseURL.scheme == "https" ? "wss" : "ws" }
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }
    func history(after: Int, epoch: Int? = nil) async throws -> HistoryPage {
        let (data, response) = try await session.data(for: request(path: "/agents/niao-agent/personal/history?after=\(after)&epoch=\(epoch ?? 0)"))
        guard let http = response as? HTTPURLResponse else { throw NiaoError.protocolMismatch }
        if http.statusCode == 401 { throw NiaoError.unauthorized }
        guard http.statusCode == 200 else { throw NiaoError.http(http.statusCode) }
        let page = try JSONDecoder().decode(HistoryPage.self, from: data)
        guard page.v == 1 else { throw NiaoError.protocolMismatch }
        return page
    }
    private struct Failure: Decodable { let code: String }
    private func controlRequest<T: Decodable>(path: String, method: String, body: Data? = nil, epoch: Int? = nil) async throws -> T {
        var req = request(path: path)
        req.httpMethod = method
        req.httpBody = body
        if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let epoch { req.setValue("\"\(epoch)\"", forHTTPHeaderField: "If-Match") }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw NiaoError.protocolMismatch }
        if http.statusCode == 401 { throw NiaoError.unauthorized }
        guard http.statusCode == 200 else {
            if let failure = try? JSONDecoder().decode(Failure.self, from: data) { throw NiaoError.api(failure.code) }
            throw NiaoError.http(http.statusCode)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func updateModelSettings(_ modelId: String, thinkingEnabled: Bool) async throws -> AgentSettings {
        let body = try JSONEncoder().encode(ModelSettingsUpdate(modelId: modelId, thinkingEnabled: thinkingEnabled))
        return try await controlRequest(path: "/agents/niao-agent/personal/settings", method: "PUT", body: body)
    }
    func clearHistory(epoch: Int) async throws -> ClearHistoryResult {
        try await controlRequest(path: "/agents/niao-agent/personal/history", method: "DELETE", epoch: epoch)
    }
    func usage() async throws -> UsageSnapshot {
        let (data, response) = try await session.data(for: request(path: "/agents/niao-agent/personal/usage"))
        guard let http = response as? HTTPURLResponse else { throw NiaoError.protocolMismatch }
        if http.statusCode == 401 { throw NiaoError.unauthorized }
        guard http.statusCode == 200 else { throw NiaoError.http(http.statusCode) }
        let usage = try JSONDecoder().decode(UsageSnapshot.self, from: data)
        guard usage.v == 1 else { throw NiaoError.protocolMismatch }
        return usage
    }
    func socket() -> URLSessionWebSocketTask {
        let task = session.webSocketTask(with: request(path: "/agents/niao-agent/personal", websocket: true))
        task.maximumMessageSize = 1_000_000
        task.resume()
        return task
    }
    static func event(from socket: URLSessionWebSocketTask) async throws -> ServerEvent {
        let raw = try await socket.receive()
        let data: Data
        switch raw {
        case .string(let string): data = Data(string.utf8)
        case .data(let bytes): data = bytes
        @unknown default: throw NiaoError.protocolMismatch
        }
        return try JSONDecoder().decode(ServerEvent.self, from: data)
    }
}
