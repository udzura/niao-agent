import XCTest
@testable import NiaoCore

final class CredentialSessionTests: XCTestCase {
    @MainActor func testAuthenticatesOnceUntilLockedAndKeepsBackendValuesSeparate() async throws {
        var authentications = 0
        var values = ["a":"first", "b":"second"]
        let session = CredentialSession(authenticate: { authentications += 1 },
            read: { values[$0] ?? "" }, save: { values[$1] = $0 })
        let first = try await session.read(backend: "a")
        let second = try await session.read(backend: "b")
        XCTAssertEqual(first, "first"); XCTAssertEqual(second, "second")
        try await session.save("updated", backend: "a")
        XCTAssertEqual(authentications, 1)
        XCTAssertEqual(values["a"], "updated")
        session.lock()
        _ = try await session.read(backend: "a")
        XCTAssertEqual(authentications, 2)
    }
    @MainActor func testDeniedAuthenticationNeverReadsOrWritesAndCanRetry() async {
        var accepted = false
        var accesses = 0
        let session = CredentialSession(authenticate: {
            if !accepted { throw NiaoError.authentication("cancelled") }
        }, read: { _ in accesses += 1; return "value" }, save: { _,_ in accesses += 1 })
        do { _ = try await session.read(backend: "a"); XCTFail("Read was allowed") } catch { }
        do { try await session.save("new",backend: "a"); XCTFail("Write was allowed") } catch { }
        XCTAssertEqual(accesses, 0)
        accepted = true
        do { _ = try await session.read(backend: "a") } catch { XCTFail("Retry failed") }
        XCTAssertEqual(accesses, 1)
    }
    @MainActor func testConcurrentReadsShareOneOwnerAuthentication() async throws {
        var authentications = 0
        let session = CredentialSession(authenticate: { authentications += 1; await Task.yield() },
            read: { $0 }, save: { _,_ in })
        async let first = session.read(backend: "a")
        async let second = session.read(backend: "b")
        let result = try await (first,second)
        XCTAssertEqual(result.0, "a"); XCTAssertEqual(result.1, "b")
        XCTAssertEqual(authentications, 1)
    }
    @MainActor func testLockDuringAuthenticationPreventsSecretAccess() async {
        var session: CredentialSession!
        var accesses = 0
        session = CredentialSession(authenticate: { session.lock() },
            read: { _ in accesses += 1; return "secret" }, save: { _,_ in accesses += 1 })
        do { _ = try await session.read(backend: "a"); XCTFail("Read survived lock") }
        catch is CancellationError { }
        catch { XCTFail("Unexpected error") }
        XCTAssertEqual(accesses, 0)
    }
    @MainActor func testLockDuringKeychainReadDiscardsItsResult() async {
        var session: CredentialSession!
        session = CredentialSession(authenticate: {},
            read: { _ in session.lock(); return "secret" }, save: { _,_ in })
        do { _ = try await session.read(backend: "a"); XCTFail("Stale secret returned") }
        catch is CancellationError { }
        catch { XCTFail("Unexpected error") }
    }
}
