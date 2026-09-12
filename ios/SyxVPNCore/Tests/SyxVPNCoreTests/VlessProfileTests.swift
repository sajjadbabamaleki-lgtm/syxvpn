import XCTest
@testable import SyxVPNCore

/// The most security-relevant parser in the app.
///
/// A profile that parses wrong is a tunnel to somewhere else, or no tunnel at
/// all — the two failures worth a test more than any other. These are the same
/// cases the Android client is held to, so the two ports cannot drift apart
/// without one of them going red.
///
/// The literals are what `server/src/domain/xray.js` really emits.
final class VlessProfileTests: XCTestCase {

    func testReadsAWebsocketProfileAsTheControlPlaneWritesIt() throws {
        let profile = try XCTUnwrap(VlessProfile.parse(
            "vless://11111111-2222-3333-4444-555555555555@edge.example.net:443"
            + "?encryption=none&type=ws&path=%2Fws&host=edge.example.net"
            + "&security=tls&sni=edge.example.net&fp=chrome#Edge%20A%20%C2%B7%20tehran"
        ))
        XCTAssertEqual(profile.uuid, "11111111-2222-3333-4444-555555555555")
        XCTAssertEqual(profile.host, "edge.example.net")
        XCTAssertEqual(profile.port, 443)
        XCTAssertTrue(profile.tls)
        XCTAssertEqual(profile.sni, "edge.example.net")
        XCTAssertEqual(profile.wsPath, "/ws")
        XCTAssertEqual(profile.wsHost, "edge.example.net")
        XCTAssertEqual(profile.label, "Edge A · tehran")
        XCTAssertNil(profile.reality)
    }

    func testReadsARealityProfileAsTheControlPlaneWritesIt() throws {
        let profile = try XCTUnwrap(VlessProfile.parse(
            "vless://11111111-2222-3333-4444-555555555555@203.0.113.9:443"
            + "?encryption=none&security=reality&type=tcp&flow=xtls-rprx-vision"
            + "&sni=www.microsoft.com&fp=chrome"
            + "&pbk=uNm292XHIOI0wHLfn5fiOOquk47pn6kjiYhqwermDjA&sid=a1b2c3d4#Edge%20R"
        ))
        let reality = try XCTUnwrap(profile.reality)
        XCTAssertEqual(reality.publicKey, "uNm292XHIOI0wHLfn5fiOOquk47pn6kjiYhqwermDjA")
        XCTAssertEqual(reality.shortId, "a1b2c3d4")
        XCTAssertEqual(reality.flow, "xtls-rprx-vision")
        XCTAssertEqual(reality.fingerprint, "chrome")
        // The name claimed in the handshake is the borrowed site's, and the
        // socket still goes to the gateway's own address.
        XCTAssertEqual(reality.serverName, "www.microsoft.com")
        XCTAssertEqual(profile.host, "203.0.113.9")
        XCTAssertTrue(profile.tls)
    }

    func testARealityProfileWithNoPublicKeyIsRefusedNotHalfBuilt() {
        // There would be nothing to encrypt to. Connecting anyway means being
        // forwarded to the borrowed site and told, at length, that the tunnel
        // is fine.
        let without = "vless://uuid@203.0.113.9:443?security=reality&type=tcp&sid=a1b2c3d4"
        XCTAssertNil(VlessProfile.parse(without))
        XCTAssertNil(VlessProfile.parse(without + "&pbk="))
    }

    func testRealityOverAnythingButTcpIsRefused() {
        XCTAssertNil(VlessProfile.parse("vless://uuid@h:443?security=reality&type=ws&pbk=abc"))
    }

    func testAShortIdMayBeAbsentWhichMeansTheGatewayTakesAnySubscriber() throws {
        let profile = try XCTUnwrap(VlessProfile.parse(
            "vless://uuid@203.0.113.9:443?security=reality&type=tcp&pbk=abc&sni=example.org"
        ))
        XCTAssertEqual(profile.reality?.shortId, "")
    }

    func testDefaultsMatchWhatAProfileLeavesOut() throws {
        let profile = try XCTUnwrap(
            VlessProfile.parse("vless://uuid@edge.example.net:8443?security=none")
        )
        XCTAssertEqual(profile.wsPath, "/ws")
        XCTAssertNil(profile.wsHost)
        XCTAssertNil(profile.sni)
        XCTAssertFalse(profile.tls)
        // No fragment: the address is the only name there is.
        XCTAssertEqual(profile.label, "edge.example.net")
    }

    func testALabelSurvivesBeingALabel() throws {
        // Real ones carry spaces, middots and Persian, and are often not
        // encoded at all — which is exactly what URL(string:) refuses.
        let raw = try XCTUnwrap(VlessProfile.parse("vless://uuid@h:443#Frankfurt · سریع"))
        XCTAssertEqual(raw.label, "Frankfurt · سریع")

        let encoded = try XCTUnwrap(
            VlessProfile.parse("vless://uuid@h:443#%D8%A2%D9%84%D9%85%D8%A7%D9%86")
        )
        // Multi-byte UTF-8 decoded as a whole rather than escape by escape,
        // which is where mojibake comes from.
        XCTAssertEqual(encoded.label, "آلمان")

        let question = try XCTUnwrap(VlessProfile.parse("vless://uuid@h:443?type=ws#Berlin · fast?"))
        XCTAssertEqual(question.label, "Berlin · fast?")
        XCTAssertEqual(question.wsPath, "/ws")
    }

    func testAPlusIsAPlusNotASpace() throws {
        // '+' for space belongs to HTML form encoding. A WebSocket path of
        // "/ws+1" is a real path, and turning it into "/ws 1" is a 404.
        let escaped = try XCTUnwrap(VlessProfile.parse("vless://uuid@h:443?type=ws&path=%2Fws%2B1"))
        XCTAssertEqual(escaped.wsPath, "/ws+1")
        let plain = try XCTUnwrap(VlessProfile.parse("vless://uuid@h:443?type=ws&path=/ws+1"))
        XCTAssertEqual(plain.wsPath, "/ws+1")
    }

    func testAnIPv6GatewayKeepsItsAddressAndItsPortApart() throws {
        let profile = try XCTUnwrap(VlessProfile.parse("vless://uuid@[2001:db8::1]:8443?type=ws"))
        XCTAssertEqual(profile.host, "2001:db8::1")
        XCTAssertEqual(profile.port, 8443)
    }

    func testABareIPv6AddressWithoutBracketsIsRefusedRatherThanGuessedAt() {
        XCTAssertNil(VlessProfile.parse("vless://uuid@2001:db8::1:8443?type=ws"))
    }

    func testAProfileWithNoPortIsRefused() {
        // Xray would have to invent one, and the gateway is not on 443 because
        // somebody hoped so.
        XCTAssertNil(VlessProfile.parse("vless://uuid@edge.example.net?type=ws"))
        XCTAssertNil(VlessProfile.parse("vless://uuid@edge.example.net:0?type=ws"))
        XCTAssertNil(VlessProfile.parse("vless://uuid@edge.example.net:99999?type=ws"))
        XCTAssertNil(VlessProfile.parse("vless://uuid@edge.example.net:https?type=ws"))
    }

    func testAProfileWithNoCredentialIsRefused() {
        XCTAssertNil(VlessProfile.parse("vless://edge.example.net:443?type=ws"))
        XCTAssertNil(VlessProfile.parse("vless://@edge.example.net:443?type=ws"))
    }

    func testAnotherSchemeIsNotAVlessProfile() {
        for other in [
            "vmess://uuid@h:443", "trojan://p@h:443", "https://example.com",
            "vless:/uuid@h:443", "", "vless://",
        ] {
            XCTAssertNil(VlessProfile.parse(other), other)
        }
    }

    func testATransportThisAppCannotOpenIsRefusedRatherThanMisconfigured() {
        for type in ["grpc", "http", "quic", "kcp", "xhttp"] {
            XCTAssertNil(VlessProfile.parse("vless://uuid@h:443?type=\(type)"), type)
        }
    }

    func testTheOriginalLineIsKeptSoItCanBeCopiedOutAgain() throws {
        let line = "vless://uuid@h:443?type=ws&path=%2Fws#Edge"
        let profile = try XCTUnwrap(VlessProfile.parse(line))
        XCTAssertEqual(profile.uri, line)
    }

    func testARepeatedParameterTakesTheFirstAsEveryOtherClientDoes() throws {
        let profile = try XCTUnwrap(
            VlessProfile.parse("vless://uuid@h:443?type=ws&path=/first&path=/second")
        )
        XCTAssertEqual(profile.wsPath, "/first")
    }

    func testAnEmojiInALabelSurvivesEscapedOrNot() throws {
        // A flag is a pair of scalars. Re-encoding characters that were never
        // escaped damages them, and half of every flag in a server list is
        // damage nobody traces back to a URI parser.
        let plain = try XCTUnwrap(VlessProfile.parse("vless://uuid@h:443#🇩🇪 Frankfurt"))
        XCTAssertEqual(plain.label, "🇩🇪 Frankfurt")

        let escaped = try XCTUnwrap(
            VlessProfile.parse("vless://uuid@h:443#%F0%9F%87%A9%F0%9F%87%AA%20Frankfurt")
        )
        XCTAssertEqual(escaped.label, "🇩🇪 Frankfurt")
        XCTAssertEqual(plain.label, escaped.label)
    }

    func testAStrayPercentIsAPercentNotASwallowedCharacter() {
        XCTAssertEqual(UriParts.percentDecode("100% up"), "100% up")
        XCTAssertEqual(UriParts.percentDecode("%zz"), "%zz")
        XCTAssertEqual(UriParts.percentDecode("ends with %"), "ends with %")
    }
}
