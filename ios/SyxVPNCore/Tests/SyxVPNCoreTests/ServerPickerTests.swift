import XCTest
@testable import SyxVPNCore

/// The Kotlin has no suite of its own for this — SmartConnect's tests exercise
/// it indirectly. It decides what the tunnel connects to, so here it gets one.
final class ServerPickerTests: XCTestCase {

    private func server(
        _ host: String, _ state: RouteState = .healthy, port: Int = 443
    ) -> Server {
        let profile = VlessProfile.parse("vless://uuid@\(host):\(port)?type=ws#\(host)")!
        return Server(profile: profile, routeState: state)
    }

    func testHealthOutranksSpeed() {
        // A fast first hop says nothing about whether the gateway can still
        // reach the internet. That is the whole reason the order is this way.
        let fast = server("fast.example", .degraded)
        let sound = server("sound.example", .healthy)
        let probes = [
            fast.key: Probe(key: fast.key, rttMs: 10, attempted: true),
            sound.key: Probe(key: sound.key, rttMs: 300, attempted: true),
        ]
        XCTAssertEqual(
            ServerPicker.rank([fast, sound], probes: probes).first?.key, sound.key
        )
    }

    func testAServerThatWasAskedAndDidNotAnswerGoesLast() {
        let silent = server("silent.example", .healthy)
        let answering = server("ok.example", .unknown)
        let probes = [silent.key: Probe(key: silent.key, rttMs: nil, attempted: true)]
        XCTAssertEqual(
            ServerPicker.rank([silent, answering], probes: probes).map(\.key),
            [answering.key, silent.key],
            "healthy but unreachable is still unreachable"
        )
    }

    func testNeverMeasuredSortsAfterMeasuredInTheSameClass() {
        // An unknown number is not a good number.
        let measured = server("measured.example")
        let unmeasured = server("unmeasured.example")
        let probes = [measured.key: Probe(key: measured.key, rttMs: 200, attempted: true)]
        XCTAssertEqual(
            ServerPicker.rank([unmeasured, measured], probes: probes).first?.key, measured.key
        )
    }

    func testTheOrderIsStableWhenNothingSeparatesTwoServers() {
        let a = server("a.example")
        let b = server("b.example")
        XCTAssertEqual(ServerPicker.rank([a, b]).map(\.key), [a.key, b.key])
        XCTAssertEqual(ServerPicker.rank([b, a]).map(\.key), [b.key, a.key])
    }

    func testASmallSpeedGainDoesNotMoveAConnectedTunnel() {
        // Switching costs every open connection, so the gain has to be one a
        // person would notice.
        let inUse = server("in-use.example")
        let other = server("other.example")
        let probes = [
            inUse.key: Probe(key: inUse.key, rttMs: 100, attempted: true),
            other.key: Probe(key: other.key, rttMs: 100 - ServerPicker.minImprovementMs + 1,
                             attempted: true),
        ]
        XCTAssertEqual(
            ServerPicker.pick([inUse, other], probes: probes, current: inUse.key)?.key,
            inUse.key
        )
    }

    func testALargeSpeedGainDoesMoveIt() {
        let inUse = server("in-use.example")
        let other = server("other.example")
        let probes = [
            inUse.key: Probe(key: inUse.key, rttMs: 300, attempted: true),
            other.key: Probe(key: other.key, rttMs: 50, attempted: true),
        ]
        XCTAssertEqual(
            ServerPicker.pick([inUse, other], probes: probes, current: inUse.key)?.key,
            other.key
        )
    }

    func testAConnectedServerThatStoppedAnsweringIsNotDefended() {
        let inUse = server("in-use.example")
        let other = server("other.example", .unverified)
        let probes = [inUse.key: Probe(key: inUse.key, rttMs: nil, attempted: true)]
        XCTAssertEqual(
            ServerPicker.pick([inUse, other], probes: probes, current: inUse.key)?.key,
            other.key
        )
    }

    func testProvenEndToEndBeatsUntestedWhichBeatsFailed() {
        // The three states are distinct on purpose: "tested and silent" must
        // not be collapsed with "nobody could ask".
        let proven = server("proven.example")
        let untested = server("untested.example")
        let failedOne = server("failed.example")
        let order = ServerPicker.connectOrder(
            [failedOne, untested, proven],
            endToEnd: [proven.key: 120, failedOne.key: Int64?.none]
        )
        XCTAssertEqual(order.map(\.key), [proven.key, untested.key, failedOne.key])
    }

    func testWithNoEndToEndEvidenceThePickLeadsAndTheRestFollow() {
        let a = server("a.example", .healthy)
        let b = server("b.example", .degraded)
        let order = ServerPicker.connectOrder([b, a])
        XCTAssertEqual(order.first?.key, a.key)
        XCTAssertEqual(order.count, 2, "a fallback is kept, never dropped")
    }

    func testNoServersIsAnEmptyOrderNotACrash() {
        XCTAssertNil(ServerPicker.pick([]))
        XCTAssertTrue(ServerPicker.connectOrder([]).isEmpty)
        XCTAssertTrue(ServerPicker.connectOrder([], endToEnd: ["ghost:443": 10]).isEmpty)
    }
}
