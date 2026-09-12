import XCTest
@testable import SyxVPNCore

/// The weights are a scoring system, and a scoring system whose weights do not
/// sum to the same number per purpose is not comparing like with like: one
/// purpose would simply score every server higher than another, and the app
/// would look as though it preferred that purpose's servers.
final class PurposeTests: XCTestCase {

    func testEveryPurposeWeighsToOne() {
        for purpose in Purpose.allCases {
            XCTAssertEqual(purpose.weights.sum, 1.0, accuracy: 1e-9, purpose.label)
        }
    }

    func testGamingLeansOnTheRoundTripAndSocialOnTheRecord() {
        // Not decoration: these two genuinely pick different gateways out of
        // one list, and this is the reason why.
        XCTAssertGreaterThan(Purpose.gaming.weights.latency, Purpose.social.weights.latency)
        XCTAssertGreaterThan(
            Purpose.social.weights.reliability, Purpose.gaming.weights.reliability
        )
    }

    func testAnUnknownOrAbsentNameIsAutoRatherThanAFailure() {
        // It arrives from stored settings, which outlive any one build.
        XCTAssertEqual(Purpose.of(nil), .auto)
        XCTAssertEqual(Purpose.of(""), .auto)
        XCTAssertEqual(Purpose.of("whatever-this-was"), .auto)
        XCTAssertEqual(Purpose.of("gaming"), .gaming)
        XCTAssertEqual(Purpose.of("GAMING"), .gaming)
    }
}
