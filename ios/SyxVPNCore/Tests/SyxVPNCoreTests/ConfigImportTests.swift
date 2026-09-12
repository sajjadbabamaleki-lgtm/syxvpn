import XCTest
@testable import SyxVPNCore

/// What a person actually has in their clipboard.
///
/// Every shape here is one somebody really pastes, and the cost of rejecting
/// any of them is the same: a person holding the right thing being told it is
/// wrong, with no way to find out which part of it was the problem.
final class ConfigImportTests: XCTestCase {

    private let one = "vless://11111111-2222-3333-4444-555555555555@a.example.net:443"
        + "?type=ws&path=%2Fws#Server A"
    private let two = "vless://22222222-2222-3333-4444-555555555555@b.example.net:8443?type=ws#Server B"
    private let reality = "vless://33333333-2222-3333-4444-555555555555@203.0.113.9:443"
        + "?security=reality&type=tcp&flow=xtls-rprx-vision&sni=www.microsoft.com&fp=chrome"
        + "&pbk=uNm292XHIOI0wHLfn5fiOOquk47pn6kjiYhqwermDjA&sid=a1b2c3d4#Reality"

    private func base64(_ text: String) -> String {
        Data(text.utf8).base64EncodedString()
    }

    func testOnePastedConfig() {
        let result = ConfigImport.parse(one)
        XCTAssertEqual(result.added.count, 1)
        XCTAssertEqual(result.added.first?.host, "a.example.net")
        XCTAssertEqual(result.rejected, 0)
    }

    func testAWholeListAtOnceInTheOrderItWasPasted() {
        let result = ConfigImport.parse("\(one)\n\(two)\n\(reality)")
        XCTAssertEqual(
            result.added.map(\.host), ["a.example.net", "b.example.net", "203.0.113.9"]
        )
    }

    func testBlankLinesStraySpacesAndWindowsLineEndings() {
        // Copied out of a chat app, which is where these actually come from.
        let messy = "\r\n  \(one)  \r\n\r\n\t\(two)\r\n   \r\n"
        XCTAssertEqual(ConfigImport.parse(messy).added.count, 2)
    }

    func testTheBase64BlobASubscriptionURLAnswersWith() {
        // People paste the *answer* as often as they paste the link.
        let result = ConfigImport.parse(base64("\(one)\n\(two)"))
        XCTAssertEqual(result.added.count, 2)
        XCTAssertEqual(result.added.first?.host, "a.example.net")
    }

    func testBase64ThatIsUrlSafeOrUnpaddedOrWrappedAcrossLines() {
        let padded = base64("\(one)\n\(two)")
        let urlSafe = padded.replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
        var unpadded = padded
        while unpadded.hasSuffix("=") { unpadded.removeLast() }
        let wrapped = stride(from: 0, to: padded.count, by: 64).map { offset -> String in
            let start = padded.index(padded.startIndex, offsetBy: offset)
            let end = padded.index(start, offsetBy: min(64, padded.count - offset))
            return String(padded[start..<end])
        }.joined(separator: "\n")
        // Subscription endpoints disagree about all three, and a person pasting
        // one has no idea which they were handed.
        for variant in [padded, urlSafe, unpadded, wrapped] {
            XCTAssertEqual(ConfigImport.parse(variant).added.count, 2, String(variant.prefix(12)))
        }
    }

    func testCommentLinesAreSkippedButALabelAfterAHashIsNotAComment() {
        let withComments = "# my servers\n\(one)\n// from the channel\n\(two)"
        let result = ConfigImport.parse(withComments)
        XCTAssertEqual(result.added.count, 2)
        // "#Server A" is the config's own name and lives inside the line.
        XCTAssertEqual(result.added.first?.label, "Server A")
        XCTAssertEqual(result.rejected, 0)
    }

    func testPastingTheSameListTwiceDoesNotDoubleIt() {
        // What happens when somebody re-copies a whole channel post to get the
        // one new server in it.
        let first = ConfigImport.parse("\(one)\n\(two)")
        let again = ConfigImport.parse(
            "\(one)\n\(two)\n\(reality)", existing: first.added.map(\.uri)
        )
        XCTAssertEqual(again.added.count, 1)
        XCTAssertEqual(again.duplicates, 2)
        XCTAssertEqual(again.added.first?.host, "203.0.113.9")
    }

    func testADuplicateInsideOnePasteCountsOnce() {
        let result = ConfigImport.parse("\(one)\n\(one)\n\(two)")
        XCTAssertEqual(result.added.count, 2)
        XCTAssertEqual(result.duplicates, 1)
    }

    func testWhatCannotBeReadIsCountedNotSilentlyDropped() {
        let result = ConfigImport.parse("\(one)\nvless://broken\nnot a config at all\n\(two)")
        XCTAssertEqual(result.added.count, 2)
        XCTAssertEqual(result.rejected, 2)
        XCTAssertTrue(result.summary().contains("could not be read"))
    }

    func testAProtocolTheTunnelCannotRunIsRefusedRatherThanHalfAccepted() {
        // Taking a line and failing at connect time is worse than saying so
        // now. vmess is not one of the three the core is built to dial here.
        let result = ConfigImport.parse("vmess://eyJ2IjoiMiJ9\nhttp://example.net\nnot a config")
        XCTAssertTrue(result.isEmpty)
        XCTAssertEqual(result.rejected, 3)
    }

    func testTheOtherTwoProtocolsTheAppSpeaksAreReadLikeAnyOtherLine() throws {
        // Shadowsocks and trojan arrive in the same places vless does: a
        // subscription, a channel, a friend. A person pasting one is not
        // pasting a mistake.
        let result = ConfigImport.parse(
            "ss://YWVzLTI1Ni1nY206c2VjcmV0@h.example.net:8388#SS\n"
            + "trojan://password@h.example.net:443?sni=h.example.net#TJ"
        )
        XCTAssertEqual(result.added.count, 2)
        XCTAssertEqual(result.rejected, 0)

        let ss = try XCTUnwrap(result.added[0] as? ShadowsocksProfile)
        XCTAssertEqual(ss.method, "aes-256-gcm")
        XCTAssertEqual(ss.password, "secret")
        XCTAssertEqual(ss.port, 8388)

        let trojan = try XCTUnwrap(result.added[1] as? TrojanProfile)
        XCTAssertEqual(trojan.password, "password")
        XCTAssertEqual(trojan.sni, "h.example.net")
    }

    func testNothingAtAllIsNotAnErrorItIsNothing() {
        for empty in ["", "   ", "\n\n", "# just a comment"] {
            let result = ConfigImport.parse(empty)
            XCTAssertTrue(result.isEmpty, empty)
            XCTAssertEqual(result.rejected, 0, empty)
            XCTAssertEqual(result.summary(), "Nothing to add")
        }
    }

    func testTheSummarySaysWhatHappenedInThePersonsTerms() {
        XCTAssertEqual(ConfigImport.parse(one).summary(), "Added 1 config")
        XCTAssertEqual(ConfigImport.parse("\(one)\n\(two)").summary(), "Added 2 configs")
        XCTAssertEqual(
            ConfigImport.parse(one, existing: [one]).summary(), "You already have that one"
        )
        XCTAssertEqual(
            ConfigImport.parse("\(one)\n\(two)", existing: [one, two]).summary(),
            "You already have all 2"
        )
        XCTAssertEqual(
            ConfigImport.parse("nonsense").summary(), "That does not look like a config"
        )
        XCTAssertEqual(
            ConfigImport.parse("\(one)\n\(two)\nrubbish", existing: [one]).summary(),
            "Added 1 config, 1 already here, 1 could not be read"
        )
    }

    func testARealityConfigFromSomebodyElseWorksLikeAnyOther() throws {
        // Nothing here is specific to configs this control plane issued.
        let result = ConfigImport.parse(reality)
        XCTAssertEqual(result.added.count, 1)
        let profile = try XCTUnwrap(result.added.first as? VlessProfile)
        XCTAssertEqual(
            profile.reality?.publicKey, "uNm292XHIOI0wHLfn5fiOOquk47pn6kjiYhqwermDjA"
        )
    }

    func testALongPasteIsReadOnceNotUnwrappedForever() {
        // base64 of base64 is not a format anybody produces, and chasing it
        // would be a way to hang on a large paste.
        let doubled = base64(base64("\(one)\n\(two)"))
        XCTAssertTrue(ConfigImport.parse(doubled).isEmpty)
    }
}
