import Foundation
import Security
import LocalAuthentication

@MainActor
final class Keychain {
    private static let session = CredentialSession(authenticate: authenticate, read: { backend in
        try await Task.detached { try StoredKeychain.read(backend: backend) }.value
    }, save: { token, backend in
        try await Task.detached { try StoredKeychain.save(token, backend: backend) }.value
    })
    static func read(backend: String) async throws -> String {
        #if os(iOS)
        // Checking item metadata exposes no credential. First-time setup should
        // not ask for biometrics before there is a saved token to unlock.
        guard try await Task.detached(operation: { try StoredKeychain.contains(backend: backend) }).value else { return "" }
        #endif
        return try await session.read(backend: backend)
    }
    static func save(_ token: String, backend: String) async throws { try await session.save(token, backend: backend) }
    static func lock() { session.lock() }
    private static func authenticate() async throws {
        let context = LAContext()
        context.localizedCancelTitle = "キャンセル"
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            #if os(iOS)
            throw NiaoError.authentication("本人確認を開始できません。Face IDまたは端末のパスコードを設定してください。")
            #else
            throw NiaoError.authentication("このMacで本人確認を開始できません。Touch IDまたはログインパスワードの設定を確認してください。")
            #endif
        }
        do {
            try await withTaskCancellationHandler {
                try Task.checkCancellation()
                let accepted = try await context.evaluatePolicy(.deviceOwnerAuthentication,
                    localizedReason: "Niaoの接続トークンをKeychainから利用します。")
                guard accepted else { throw NiaoError.authentication("本人確認が完了しませんでした。") }
                try Task.checkCancellation()
            } onCancel: { context.invalidate() }
        } catch is CancellationError { throw CancellationError() }
        catch {
            if Task.isCancelled { throw CancellationError() }
            throw NiaoError.authentication("本人確認を完了できませんでした。再接続するともう一度認証できます。")
        }
    }
}

// Synchronous Security APIs run off the main thread, after owner authentication.
// Keep the service name stable so existing per-backend credentials can migrate.
enum StoredKeychain {
    static func query(_ backend: String, dataProtection: Bool = true) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "dev.niao.Niao.backend-token",
         kSecAttrAccount as String: backend,
         kSecUseDataProtectionKeychain as String: dataProtection]
    }
    static func contains(backend: String) throws -> Bool {
        var request = query(backend)
        request[kSecReturnAttributes as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        let status = SecItemCopyMatching(request as CFDictionary, nil)
        if status == errSecItemNotFound { return false }
        guard status == errSecSuccess else { throw NiaoError.keychain(status) }
        return true
    }
    static func read(backend: String) throws -> String {
        #if os(macOS)
        return try CredentialMigration.read(current: { try value(backend: backend) },
            legacy: { try value(backend: backend, dataProtection: false) },
            insert: { try insert($0, backend: backend) })
        #else
        return try value(backend: backend) ?? ""
        #endif
    }
    private static func value(backend: String, dataProtection: Bool = true) throws -> String? {
        var request = query(backend, dataProtection: dataProtection)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw NiaoError.keychain(status) }
        guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
            throw NiaoError.keychain(errSecDecode)
        }
        return value
    }
    // Returns false if a concurrent write already created the destination item.
    private static func insert(_ token: String, backend: String) throws -> Bool {
        var item = query(backend)
        item[kSecValueData as String] = Data(token.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecDuplicateItem { return false }
        guard status == errSecSuccess else { throw NiaoError.keychain(status) }
        return true
    }
    static func save(_ token: String, backend: String) throws {
        let changes = [kSecValueData as String: Data(token.utf8)]
        let status = SecItemUpdate(query(backend) as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound {
            if try !insert(token, backend: backend) {
                let updated = SecItemUpdate(query(backend) as CFDictionary, changes as CFDictionary)
                guard updated == errSecSuccess else { throw NiaoError.keychain(updated) }
            }
        } else if status != errSecSuccess { throw NiaoError.keychain(status) }
    }
}
