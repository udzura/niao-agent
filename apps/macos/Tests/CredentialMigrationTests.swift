import XCTest
@testable import NiaoCore

final class CredentialMigrationTests: XCTestCase {
    private enum Failure: Error { case denied, write }

    func testCurrentCredentialWinsWithoutAccessingLegacyStore() throws {
        let value = try CredentialMigration.read(current: { "current" }, legacy: {
            XCTFail("Legacy store must not be consulted"); return "old"
        }, insert: { _ in XCTFail("Current value must not be replaced"); return true })
        XCTAssertEqual(value, "current")
    }
    func testCopiesAndReadsBackPersistedLegacyValue() throws {
        let legacy = "existing"
        var current: String?
        let value = try CredentialMigration.read(current: { current }, legacy: { legacy }, insert: {
            current = $0; return true
        })
        XCTAssertEqual(value, legacy)
        XCTAssertEqual(current, legacy)
    }
    func testNoStoredCredentialDoesNotCreateAnEmptyItem() throws {
        let value = try CredentialMigration.read(current: { nil }, legacy: { nil }, insert: { _ in
            XCTFail("No credential to copy"); return true
        })
        XCTAssertEqual(value, "")
    }
    func testCurrentStoreFailureNeverFallsBackToLegacy() {
        XCTAssertThrowsError(try CredentialMigration.read(current: { throw Failure.denied }, legacy: {
            XCTFail("Do not bypass destination access errors"); return "old"
        }, insert: { _ in XCTFail(); return true }))
    }
    func testDeniedLegacyReadDoesNotWrite() {
        XCTAssertThrowsError(try CredentialMigration.read(current: { nil }, legacy: { throw Failure.denied },
            insert: { _ in XCTFail(); return true }))
    }
    func testFailedWriteDoesNotReturnLegacyCredential() {
        XCTAssertThrowsError(try CredentialMigration.read(current: { nil }, legacy: { "old" },
            insert: { _ in throw Failure.write }))
    }
    func testVerificationRequiresPersistedMatchingValue() {
        for persisted in [nil, "different"] as [String?] {
            var reads = 0
            XCTAssertThrowsError(try CredentialMigration.read(current: {
                reads += 1; return reads == 1 ? nil : persisted
            }, legacy: { "old" }, insert: { _ in true })) { error in
                XCTAssertTrue(error is CredentialMigrationError)
            }
        }
    }
    func testConcurrentSaveIsNotOverwrittenByMigration() throws {
        var current: String?
        let value = try CredentialMigration.read(current: { current }, legacy: { "old" }, insert: { _ in
            // SecItemAdd reports a duplicate when another save won the race.
            current = "newly-saved"; return false
        })
        XCTAssertEqual(value, "newly-saved")
    }
}
