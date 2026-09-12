import XCTest
@testable import SyxVPNCore

/// The selection engine, checked on the behaviour that is actually promised.
///
/// These are not shape tests. Each one states something a person would notice:
/// that Gaming and Social genuinely disagree about the same two gateways, that
/// a gateway proven end to end wins over a better-looking one that was never
/// tested, that the tunnel does not hop between gateways that are the same
/// within noise.
final class SmartConnectTests: XCTestCase {

    private func profile(_ host: String, port: Int = 443) -> VlessProfile {
        VlessProfile(
            uri: "vless://uuid@\(host):\(port)",
            uuid: "uuid",
            host: host,
            port: port,
            label: host,
            tls: true,
            sni: nil,
            wsPath: "/ws",
            wsHost: nil,
            reality: nil
        )
    }

    private func server(_ host: String, _ state: RouteState = .healthy) -> Server {
        Server(profile: profile(host), routeState: state)
    }

    func testGamingTakesTheFastGatewayAndSocialTakesTheDependableOne() {
        // One gateway is quick and even, but has refused twice since it last
        // worked; the other is 90 ms further away and has never failed once.
        // A game feels the 90 ms; a messaging app feels the refusals.
        let quick = server("quick.example.net")
        let steady = server("steady.example.net")
        let now: Int64 = 1_000_000
        let memory = ConnectionMemory.of([
            ServerStats(key: quick.key, attempts: 10, successes: 6, consecutiveFailures: 2,
                        rttMs: 40, jitterMs: 10, updatedAt: now),
            ServerStats(key: steady.key, attempts: 30, successes: 30, consecutiveFailures: 0,
                        rttMs: 130, jitterMs: 8, updatedAt: now),
        ])
        let probes = [
            quick.key: Probe(key: quick.key, rttMs: 40, attempted: true),
            steady.key: Probe(key: steady.key, rttMs: 130, attempted: true),
        ]
        let servers = [quick, steady]

        let forGaming = SmartConnect.pick(
            servers, probes: probes, memory: memory, purpose: .gaming
        )
        let forSocial = SmartConnect.pick(
            servers, probes: probes, memory: memory, purpose: .social
        )

        XCTAssertEqual(forGaming?.key, quick.key)
        XCTAssertEqual(forSocial?.key, steady.key)
        XCTAssertNotEqual(forGaming?.key, forSocial?.key)
    }

    func testGamingWillNotTakeAFastGatewayThatCannotHoldStill() {
        // 40 ms that swings by 90 is worse to play on than a steady 130, and the
        // weights have to say so or "Gaming" is just a label for "lowest ping".
        let jittery = server("jittery.example.net")
        let steady = server("steady.example.net")
        let now: Int64 = 1_000_000
        let memory = ConnectionMemory.of([
            ServerStats(key: jittery.key, attempts: 20, successes: 20,
                        rttMs: 40, jitterMs: 90, updatedAt: now),
            ServerStats(key: steady.key, attempts: 20, successes: 20,
                        rttMs: 130, jitterMs: 8, updatedAt: now),
        ])
        let probes = [
            jittery.key: Probe(key: jittery.key, rttMs: 40, attempted: true),
            steady.key: Probe(key: steady.key, rttMs: 130, attempted: true),
        ]
        let pick = SmartConnect.pick(
            [jittery, steady], probes: probes, memory: memory, purpose: .gaming
        )
        XCTAssertEqual(pick?.key, steady.key)
    }

    func testProvenEndToEndOutranksAnUntestedGatewayWithABetterScore() {
        // The untested one looks better on every signal the phone can see.
        let untested = server("fast.example.net")
        let proven = server("slow.example.net", .degraded)
        let probes = [
            untested.key: Probe(key: untested.key, rttMs: 20, attempted: true),
            proven.key: Probe(key: proven.key, rttMs: 300, attempted: true),
        ]
        let order = SmartConnect.connectOrder(
            [untested, proven], probes: probes, endToEnd: [proven.key: 400]
        )
        XCTAssertEqual(order.first?.key, proven.key)
    }

    func testAGatewayThatFailedItsTestGoesLastButStaysInTheList() {
        let ok = server("ok.example.net")
        let dead = server("dead.example.net")
        let order = SmartConnect.connectOrder(
            [dead, ok],
            probes: [dead.key: Probe(key: dead.key, rttMs: nil, attempted: true)],
            endToEnd: [dead.key: Int64?.none]
        )
        XCTAssertEqual(order.map(\.key), [ok.key, dead.key])
    }

    func testTheConnectedGatewayIsKeptWhenTheChallengerIsBarelyBetter() {
        let current = server("current.example.net")
        let challenger = server("other.example.net")
        let probes = [
            current.key: Probe(key: current.key, rttMs: 100, attempted: true),
            challenger.key: Probe(key: challenger.key, rttMs: 95, attempted: true),
        ]
        let order = SmartConnect.connectOrder(
            [challenger, current], probes: probes, current: current.key
        )
        XCTAssertEqual(order.first?.key, current.key)
    }

    func testTheConnectedGatewayIsLeftWhenTheChallengerIsClearlyBetter() {
        let current = server("current.example.net", .degraded)
        let challenger = server("other.example.net", .healthy)
        let probes = [
            current.key: Probe(key: current.key, rttMs: 400, attempted: true),
            challenger.key: Probe(key: challenger.key, rttMs: 30, attempted: true),
        ]
        let order = SmartConnect.connectOrder(
            [current, challenger], probes: probes, current: current.key
        )
        XCTAssertEqual(order.first?.key, challenger.key)
    }

    func testTheSameInputAlwaysGivesTheSameOrder() {
        let servers = (1...6).map { server("gw\($0).example.net") }
        let first = SmartConnect.connectOrder(servers).map(\.key)
        let again = SmartConnect.connectOrder(servers.reversed()).map(\.key)
        // Reversing the input may change the order — the control plane's order
        // is a tie-break — but the same input must not.
        XCTAssertEqual(SmartConnect.connectOrder(servers).map(\.key), first)
        XCTAssertEqual(SmartConnect.connectOrder(servers.reversed()).map(\.key), again)
    }

    func testEveryServerIsOfferedExactlyOnce() {
        let servers = (1...5).map { server("gw\($0).example.net") }
        let order = SmartConnect.connectOrder(
            servers,
            probes: [servers[0].key: Probe(key: servers[0].key, rttMs: nil, attempted: true)],
            endToEnd: [servers[1].key: 120, servers[2].key: Int64?.none],
            current: servers[4].key
        )
        XCTAssertEqual(order.count, servers.count)
        XCTAssertEqual(Set(order.map(\.key)), Set(servers.map(\.key)))
    }
}
