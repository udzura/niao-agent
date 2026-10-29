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
    static func read(backend: String) async throws -> String { try await session.read(backend: backend) }
    static func save(_ token: String, backend: String) async throws { try await session.save(token, backend: backend) }
    static func lock() { session.lock() }
    private static func authenticate() async throws {
        let context = LAContext()
        context.localizedCancelTitle = "キャンセル"
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            throw NiaoError.authentication("このMacで本人確認を開始できません。Touch IDまたはログインパスワードの設定を確認してください。")
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

// Existing file-based Keychain records are retained for ad-hoc build compatibility.
// These methods run off the main thread after the app-level authentication gate.
private enum StoredKeychain {
    private static func query(_ backend: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "dev.niao.Niao.backend-token",
         kSecAttrAccount as String: backend]
    }
    static func read(backend: String) throws -> String {
        var request = query(backend)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else { throw NiaoError.keychain(status) }
        return value
    }
    static func save(_ token: String, backend: String) throws {
        let request = query(backend)
        let changes = [kSecValueData as String: Data(token.utf8)]
        let status = SecItemUpdate(request as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound {
            var item = request.merging(changes) { _, new in new }
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let added = SecItemAdd(item as CFDictionary, nil)
            guard added == errSecSuccess else { throw NiaoError.keychain(added) }
        } else if status != errSecSuccess { throw NiaoError.keychain(status) }
    }
}
