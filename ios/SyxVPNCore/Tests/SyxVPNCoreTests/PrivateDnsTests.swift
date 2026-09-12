import XCTest
@testable import SyxVPNCore

final class PrivateDnsTests: XCTestCase {

    func testAPhoneThatHasNeverBeenAskedGetsTheDefault() {
        XCTAssertEqual(PrivateDns.of(nil), PrivateDns.default)
        XCTAssertEqual(PrivateDns.of(""), PrivateDns.default)
    }

    func testAStoredNameThisBuildDoesNotKnowReadsAsTheDefaultNotAsNothing() {
        // A mode dropped in a later version must not leave a phone with a
        // resolver it cannot name — and must not silently fall back to the
        // plain one either, which would downgrade someone without telling them.
        XCTAssertEqual(PrivateDns.of("HANDCRAFTED_ARTISANAL_DNS"), PrivateDns.default)
        XCTAssertTrue(PrivateDns.of("HANDCRAFTED_ARTISANAL_DNS").encrypted)
    }

    func testNamesRoundTripThroughStorageWhateverTheirCase() {
        for mode in PrivateDns.allCases {
            XCTAssertEqual(PrivateDns.of(mode.rawValue), mode)
            XCTAssertEqual(PrivateDns.of(mode.rawValue.lowercased()), mode)
        }
    }

    func testStandardIsTheConfigurationThatShippedBeforeThisExisted() {
        // The rollback path. If this list changes, a build with the feature off
        // stops being the build people are already running.
        XCTAssertEqual(PrivateDns.standard.addresses, ["1.1.1.1", "8.8.8.8"])
        XCTAssertFalse(PrivateDns.standard.encrypted)
    }

    func testEveryEncryptedEndpointIsAddressedByIP() throws {
        // A resolver reached by name needs a resolver to reach it, and that
        // first query is the one nobody is encrypting. Anything with letters in
        // the host here is a name, and a name here is a leak.
        for mode in PrivateDns.allCases where mode.encrypted {
            let url = try XCTUnwrap(mode.dohUrl)
            let host = url.replacingOccurrences(of: "https://", with: "").before("/")
            XCTAssertTrue(
                host.allSatisfy { $0.isNumber || $0 == "." },
                "\(mode.rawValue) resolves its own resolver by name: \(host)"
            )
            XCTAssertFalse(mode.addresses.isEmpty, "\(mode.rawValue) advertises no address")
        }
    }

    func testOnlyOneModeLeavesQueriesInClearText() {
        XCTAssertEqual(PrivateDns.allCases.filter { !$0.encrypted }, [.standard])
    }
}
