import Foundation

// A legacy credential is copied only when the current store has no item.
// The caller retains the legacy item; failures must never fall back to using it.
enum CredentialMigration {
    static func read(current: () throws -> String?, legacy: () throws -> String?,
                     insert: (String) throws -> Bool) throws -> String {
        if let value = try current() { return value }
        guard let previous = try legacy() else { return "" }
        try Task.checkCancellation()
        // Add-only avoids overwriting a credential saved concurrently with migration.
        let inserted = try insert(previous)
        guard let saved = try current(), !inserted || saved == previous else {
            throw CredentialMigrationError.verificationFailed
        }
        return saved
    }
}

enum CredentialMigrationError: LocalizedError {
    case verificationFailed
    var errorDescription: String? {
        "接続トークンの移行結果を確認できませんでした。元のKeychain項目は保持しています。設定から再試行してください。"
    }
}
