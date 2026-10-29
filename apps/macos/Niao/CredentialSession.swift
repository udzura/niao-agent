import Foundation

// One app-level owner-authentication session per awake period. This is separate
// from the OS Keychain item's access control; no claim of biometric item ACLs.
@MainActor
final class CredentialSession {
    private let authenticate: () async throws -> Void
    private let readValue: (String) async throws -> String
    private let saveValue: (String, String) async throws -> Void
    private var authentication: Task<Void, Error>?
    private var unlocked = false
    private var generation = 0

    init(authenticate: @escaping () async throws -> Void,
         read: @escaping (String) async throws -> String,
         save: @escaping (String, String) async throws -> Void) {
        self.authenticate = authenticate; readValue = read; saveValue = save
    }
    private func unlock() async throws {
        try Task.checkCancellation()
        if unlocked { return }
        let current = generation
        let task = authentication ?? Task { try await authenticate() }
        authentication = task
        defer { if current == generation { authentication = nil } }
        try await task.value
        try Task.checkCancellation()
        guard current == generation else { throw CancellationError() }
        unlocked = true
    }
    func read(backend: String) async throws -> String {
        try await unlock()
        let current = generation
        let value = try await readValue(backend)
        try Task.checkCancellation()
        guard current == generation else { throw CancellationError() }
        return value
    }
    func save(_ value: String, backend: String) async throws {
        try await unlock()
        let current = generation
        try await saveValue(value, backend)
        try Task.checkCancellation()
        guard current == generation else { throw CancellationError() }
    }
    func lock() {
        generation += 1
        unlocked = false
        authentication?.cancel()
        authentication = nil
    }
}
