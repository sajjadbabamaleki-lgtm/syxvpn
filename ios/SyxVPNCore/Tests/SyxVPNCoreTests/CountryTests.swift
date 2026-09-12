import XCTest
@testable import SyxVPNCore

/// Where a gateway is, worked out from what a subscription actually carries.
///
/// The JSON form has a region field. The plain base64 form — every subscription
/// not issued by this control plane, and this one when the JSON call fails —
/// carries nothing but the label, so the label is where the country has to come
/// from on exactly the clients least able to ask again.
final class CountryTests: XCTestCase {

    private func serverWith(_ label: String, region: String? = nil) throws -> Server {
        let profile = try XCTUnwrap(VlessProfile.parse(
            "vless://11111111-2222-3333-4444-555555555555@h.example.net:443?type=ws#"
            + label.replacingOccurrences(of: " ", with: "%20")
        ))
        return Server(profile: profile, region: region)
    }

    func testTheRegionFieldWinsWhenThereIsOne() throws {
        let server = try serverWith("Anything at all", region: "de-fra")
        XCTAssertEqual(countryOf(server)?.code, "DE")
    }

    func testALabelEndingInARegionIsRead() throws {
        XCTAssertEqual(countryOf(try serverWith("Amsterdam Edge · nl-ams"))?.code, "NL")
    }

    func testAProtocolAtTheEndOfTheLabelDoesNotHideTheCountry() throws {
        // The label of a second door is `name · region · kind`. Reading only the
        // last segment filed every one of those under "other servers".
        XCTAssertEqual(
            countryOf(try serverWith("Frankfurt Edge · de-fra · shadowsocks"))?.code, "DE"
        )
        XCTAssertEqual(countryOf(try serverWith("Helsinki Edge · fi · trojan"))?.code, "FI")
        XCTAssertEqual(countryOf(try serverWith("Stockholm · se · reality"))?.code, "SE")
    }

    func testALabelWithNoRegionInItIsNotForcedIntoACountry() throws {
        // "Other servers" is a real answer. Inventing a country for a gateway
        // whose label does not say one would put it on a map it never claimed.
        XCTAssertNil(countryOf(try serverWith("Some Server · fastest · premium")))
        XCTAssertNil(countryOf(try serverWith("My own config")))
    }

    func testAFlagIsTwoRegionalIndicatorsOrNothing() {
        XCTAssertEqual(flagEmoji("de"), "🇩🇪")
        XCTAssertEqual(flagEmoji("DE"), "🇩🇪")
        XCTAssertNil(flagEmoji("d"))
        XCTAssertNil(flagEmoji("deu"))
        XCTAssertNil(flagEmoji("d1"))
    }

    func testGroupsAreNamedAndTheUnplaceableOnesComeLast() throws {
        let groups = groupByCountry([
            try serverWith("Zurich · ch-zrh"),
            try serverWith("My own config"),
            try serverWith("Amsterdam · nl-ams"),
        ])
        XCTAssertEqual(groups.map(\.key), ["NL", "CH", "other"])
        XCTAssertEqual(groups.last?.name, "Other servers")
    }
}
