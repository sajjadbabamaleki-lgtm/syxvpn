import XCTest
@testable import SyxVPNCore

/// What matters here is the order the app tries addresses in, that a working
/// one is remembered across launches, and that a subscription link issued by an
/// address which has since gone dark is still usable.
///
/// One case from the Kotlin suite is deliberately absent: the empty list. There
/// it throws IllegalArgumentException and the test catches it; here it is a
/// precondition, which traps the process and cannot be asserted on from
/// XCTest. The check itself is kept — a build that ships no address should stop
/// at the first launch rather than fail later with an empty ordered() — but the
/// test for it would have to crash to pass.
final class ControlPlaneEndpointsTests: XCTestCase {
    private var stored: String?

    private func endpoints(_ hosts: String...) -> ControlPlaneEndpoints {
        ControlPlaneEndpoints(
            configured: hosts,
            remembered: { [weak self] in self?.stored },
            remember: { [weak self] value in self?.stored = value }
        )
    }

    override func setUp() {
        super.setUp()
        stored = nil
    }

    func testConfiguredOrderIsTheStartingOrder() {
        let e = endpoints("https://a.example", "https://b.example")
        XCTAssertEqual(e.ordered(), ["https://a.example", "https://b.example"])
        XCTAssertEqual(e.current(), "https://a.example")
    }

    func testTrailingSlashesAreRemovedSoPathsDoNotDoubleUp() {
        let e = endpoints("https://a.example/", "https://b.example")
        XCTAssertEqual(e.current(), "https://a.example")
    }

    func testBlanksAndDuplicatesAreDroppedOrderKept() {
        let e = endpoints(
            "https://a.example", "", "  ", "https://a.example/", "https://b.example"
        )
        XCTAssertEqual(e.ordered(), ["https://a.example", "https://b.example"])
    }

    func testTheOneThatWorkedIsTriedFirstNextTime() {
        let e = endpoints("https://a.example", "https://b.example", "https://c.example")
        e.worked("https://b.example")
        XCTAssertEqual(
            e.ordered(), ["https://b.example", "https://a.example", "https://c.example"]
        )
    }

    func testARememberedAddressThatIsNoLongerInTheBuildIsIgnored() {
        stored = "https://retired.example"
        let e = endpoints("https://a.example", "https://b.example")
        XCTAssertEqual(e.ordered(), ["https://a.example", "https://b.example"])
    }

    func testFailingTheRememberedAddressForgetsIt() {
        let e = endpoints("https://a.example", "https://b.example")
        e.worked("https://b.example")
        e.failed("https://b.example")
        XCTAssertNil(stored)
        XCTAssertEqual(e.current(), "https://a.example")
    }

    func testFailingAnAddressThatWasNotTheRememberedOneChangesNothing() {
        let e = endpoints("https://a.example", "https://b.example")
        e.worked("https://b.example")
        e.failed("https://a.example")
        XCTAssertEqual(stored, "https://b.example")
    }

    func testAnAddressThatFailsIsNotStruckOffTheList() {
        let e = endpoints("https://a.example", "https://b.example")
        e.failed("https://a.example")
        XCTAssertEqual(
            e.ordered().count, 2, "a blocked address today is a working one tomorrow"
        )
    }

    func testASubscriptionLinkMovesToTheAddressThatAnswers() {
        let e = endpoints("https://a.example", "https://b.example")
        XCTAssertEqual(
            e.rebase("https://a.example/sub/tok3n", onto: "https://b.example"),
            "https://b.example/sub/tok3n"
        )
    }

    func testALinkToSomewhereElseIsLeftAlone() {
        let e = endpoints("https://a.example", "https://b.example")
        let foreign = "https://someone-elses-panel.example/sub/tok3n"
        XCTAssertEqual(e.rebase(foreign, onto: "https://b.example"), foreign)
    }

    func testRebasingKeepsTheQueryTheSubscriptionWasAskedWith() {
        let e = endpoints("https://a.example", "https://b.example")
        XCTAssertEqual(
            e.rebase("https://a.example/sub/tok3n?format=json", onto: "https://b.example"),
            "https://b.example/sub/tok3n?format=json"
        )
    }

    func testAHostThatOnlyPrefixesAnotherIsNotMistakenForIt() {
        let e = endpoints("https://a.example", "https://a.example.net")
        XCTAssertEqual(
            e.rebase("https://a.example.net/sub/x", onto: "https://a.example.net"),
            "https://a.example.net/sub/x",
            "the longer host must not be rewritten as the shorter one plus a path"
        )
    }
}
