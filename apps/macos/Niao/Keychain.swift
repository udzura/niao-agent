import Foundation
import Security

enum Keychain {
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
