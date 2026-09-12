import XCTest
@testable import SyxVPNCore

/// The Kotlin has no suite here — it is welded to EncryptedSharedPreferences
/// and to Android. Putting the storage behind a protocol made these testable,
/// and two of them cover promises that would otherwise only be comments.
final class SessionStoreTests: XCTestCase {

    private func store(privateDns: Bool = true) -> SessionStore {
        SessionStore(storage: InMemorySessionStorage(), privateDnsEnabled: privateDns)
    }

    func testAFreshInstallIsNotSignedInAndThatIsFine() {
        let session = store()
        XCTAssertFalse(session.signedIn)
        XCTAssertNil(session.token)
        XCTAssertNil(session.subscriptionUrl)
        // The tunnel does not need an account, so none of this is an error state.
        XCTAssertTrue(session.importedLines.isEmpty)
    }

    func testSigningOutKeepsTheConfigsThePersonPastedIn() {
        // Bought from somebody else or handed over in a channel. Signing out of
        // this app is not a reason to lose them, and a person who had to
        // re-paste forty configs would not log back in.
        let session = store()
        session.token = "sess_abc"
        session.email = "someone@example.net"
        session.subscriptionUrl = "https://control.example/sub/tok3n"
        session.addImported(["vless://uuid@a.example:443?type=ws", "ss://x@b.example:8388"])

        session.clear()

        XCTAssertNil(session.token)
        XCTAssertNil(session.email)
        XCTAssertNil(session.subscriptionUrl)
        XCTAssertEqual(session.importedLines.count, 2, "the pasted configs are not the account's")
    }

    func testImportedConfigsKeepTheirOrderAndCanBeRemovedOneByOne() {
        let session = store()
        session.addImported(["one://a", "two://b", "three://c"])
        XCTAssertEqual(session.importedLines, ["one://a", "two://b", "three://c"])

        session.removeImported("two://b")
        XCTAssertEqual(session.importedLines, ["one://a", "three://c"])

        session.removeImported("one://a")
        session.removeImported("three://c")
        XCTAssertNil(session.importedConfigs, "an empty list is nothing, not a blank line")
    }

    func testAddingNothingChangesNothing() {
        let session = store()
        session.addImported(["one://a"])
        session.addImported([])
        XCTAssertEqual(session.importedLines, ["one://a"])
    }

    func testHiddenServersSurviveARoundTripAndWriteTheSameBytesEachTime() {
        // Read through the storage itself, because what is being checked is
        // what got written — a Set has no order, and two writes of the same set
        // must still produce one string or the file churns for nothing.
        let storage = InMemorySessionStorage()
        let session = SessionStore(storage: storage)

        session.hiddenConfigs = ["b.example:443", "a.example:443"]
        XCTAssertEqual(session.hiddenConfigs, ["a.example:443", "b.example:443"])
        let written = storage.string("hidden_configs")

        session.hiddenConfigs = ["a.example:443", "b.example:443"]
        XCTAssertEqual(storage.string("hidden_configs"), written)

        session.hiddenConfigs = []
        XCTAssertTrue(session.hiddenConfigs.isEmpty)
        XCTAssertNil(storage.string("hidden_configs"), "an empty set is nothing, not a blank line")
    }

    func testAutomaticSelectionIsOnUntilSomebodyTurnsItOff() {
        // Somebody who has just bought a plan cannot know which gateway suits
        // their network, and the tunnel can measure it.
        let session = store()
        XCTAssertTrue(session.automaticServer)
        session.automaticServer = false
        XCTAssertFalse(session.automaticServer)
    }

    func testTheDnsFlagCanBeThrownBackEvenForSomebodyWhoAlreadyChose() {
        // The rollback has to cover the phone that already picked an encrypted
        // mode, or it is not a rollback.
        let on = store(privateDns: true)
        on.dnsMode = .quad9
        XCTAssertEqual(on.dnsMode, .quad9)

        let off = store(privateDns: false)
        off.dnsMode = .quad9
        XCTAssertEqual(off.dnsMode, .standard, "a build with the flag off behaves as before")
    }

    func testAnUnknownPurposeReadsAsAutoRatherThanAsNothing() {
        let session = store()
        XCTAssertEqual(session.purpose, .auto)
        session.purposeName = "GAMING"
        XCTAssertEqual(session.purpose, .gaming)
        session.purposeName = "a-mode-this-build-never-had"
        XCTAssertEqual(session.purpose, .auto)
    }

    func testTheSecretsAreNamedSoABackendCanProtectThemDifferently() {
        // A Keychain-backed store reads this list rather than guessing. The
        // subscription URL belongs on it: on its own it is enough to use the
        // account.
        XCTAssertTrue(SessionSecrets.keys.contains("token"))
        XCTAssertTrue(SessionSecrets.keys.contains("subscription_url"))
        XCTAssertFalse(SessionSecrets.keys.contains("country"))
    }

    func testConnectionMemoryRoundTripsThroughTheStore() {
        let session = store()
        let memory = ConnectionMemory.empty.recordSample("gw1:443", rttMs: 120, now: 10)
        session.connectionMemory = memory.encode()
        XCTAssertEqual(ConnectionMemory.decode(session.connectionMemory).size, 1)
    }
}
