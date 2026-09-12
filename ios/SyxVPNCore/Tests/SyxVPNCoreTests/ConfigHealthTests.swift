import XCTest
@testable import SyxVPNCore

final class ConfigHealthTests: XCTestCase {

    private let now: Int64 = 1_000_000

    func testNeverMeasuredIsNotAVerdict() {
        XCTAssertEqual(ConfigHealth.of(probe: nil, stats: nil, now: now), .unknown)
    }

    func testTriedAndSilentIsOffline() {
        let probe = Probe(key: "gw:443", rttMs: nil, attempted: true)
        XCTAssertEqual(ConfigHealth.of(probe: probe, stats: nil, now: now), .offline)
    }

    func testPromptAndSteadyIsGood() {
        let probe = Probe(key: "gw:443", rttMs: 80, attempted: true)
        let stats = ServerStats(key: "gw:443", rttMs: 80, jitterMs: 5, updatedAt: now)
        XCTAssertEqual(ConfigHealth.of(probe: probe, stats: stats, now: now), .good)
    }

    func testSlowIsUnstableEvenWhenItAnswers() {
        let probe = Probe(key: "gw:443", rttMs: 900, attempted: true)
        XCTAssertEqual(ConfigHealth.of(probe: probe, stats: nil, now: now), .unstable)
    }

    func testARoundTripThatMovesAboutIsUnstable() {
        let probe = Probe(key: "gw:443", rttMs: 90, attempted: true)
        let stats = ServerStats(key: "gw:443", rttMs: 90, jitterMs: 300, updatedAt: now)
        XCTAssertEqual(ConfigHealth.of(probe: probe, stats: stats, now: now), .unstable)
    }

    func testARecentFailureKeepsItOffGreen() {
        let probe = Probe(key: "gw:443", rttMs: 60, attempted: true)
        let stats = ServerStats(
            key: "gw:443", consecutiveFailures: 1, rttMs: 60, jitterMs: 4, updatedAt: now
        )
        XCTAssertEqual(ConfigHealth.of(probe: probe, stats: stats, now: now), .unstable)
    }

    func testAnOldMeasurementNoLongerSpeaksForTheConfig() {
        var stale = ServerStats(
            key: "gw:443", rttMs: 50, updatedAt: now - ConfigHealth.staleAfterMs - 1
        )
        XCTAssertEqual(ConfigHealth.of(probe: nil, stats: stale, now: now), .unknown)

        stale.updatedAt = now - 1000
        XCTAssertEqual(ConfigHealth.of(probe: nil, stats: stale, now: now), .good)
    }
}
