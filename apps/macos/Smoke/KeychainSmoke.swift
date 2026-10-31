import Foundation
import Security

// Exercise the actual storage code with disposable UUID-scoped items only.
// Owner authentication is tested separately; no real Niao credential is read.
@main
struct KeychainSmoke {
    static func main() throws {
        let backend = "https://keychain-smoke-\(UUID().uuidString.lowercased()).invalid"
        defer {
            SecItemDelete(StoredKeychain.query(backend) as CFDictionary)
            SecItemDelete(StoredKeychain.query(backend, dataProtection: false) as CFDictionary)
        }
        func check(_ condition: Bool, _ label: String) throws {
            if !condition { throw NSError(domain: "KeychainSmoke", code: 1,
                                           userInfo: [NSLocalizedDescriptionKey: label]) }
        }
        func rawValue(dataProtection: Bool) throws -> String? {
            var query = StoredKeychain.query(backend, dataProtection: dataProtection)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecItemNotFound { return nil }
            guard status == errSecSuccess, let data = result as? Data else { throw NiaoError.keychain(status) }
            return String(data: data, encoding: .utf8)
        }
        try check(try !StoredKeychain.contains(backend: backend), "Destination must start empty")
        var legacy = StoredKeychain.query(backend, dataProtection: false)
        legacy[kSecValueData as String] = Data("synthetic-legacy-token".utf8)
        let status = SecItemAdd(legacy as CFDictionary, nil)
        guard status == errSecSuccess else { throw NiaoError.keychain(status) }
        try check(try StoredKeychain.read(backend: backend) == "synthetic-legacy-token", "Migration read")
        try check(try rawValue(dataProtection: true) == "synthetic-legacy-token", "Destination persistence")
        try check(try rawValue(dataProtection: false) == "synthetic-legacy-token", "Legacy preservation")
        try StoredKeychain.save("synthetic-updated-token", backend: backend)
        try check(try StoredKeychain.read(backend: backend) == "synthetic-updated-token", "Destination update")
        try check(try rawValue(dataProtection: false) == "synthetic-legacy-token", "Legacy not overwritten")
        for protection in [true, false] {
            let deleted = SecItemDelete(StoredKeychain.query(backend, dataProtection: protection) as CFDictionary)
            guard deleted == errSecSuccess else { throw NiaoError.keychain(deleted) }
        }
        try check(try !StoredKeychain.contains(backend: backend), "Cleanup")
        print("PASS data-protection=ok legacy-migration=ok update=ok legacy-preserved=ok cleanup=ok")
    }
}
