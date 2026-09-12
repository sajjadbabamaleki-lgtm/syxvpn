import Foundation

/// Picks the server to connect through.
///
/// The ordering mirrors the control plane's own egress selection, for the same
/// reason it exists there: a fast first hop tells you nothing about whether the
/// gateway can still reach the internet, so measured latency is a tie-breaker
/// *within* a health class, never a substitute for it.
///
///   1. a gateway that was measured and did not answer goes last, whatever the
///      control plane thinks of it — the phone cannot use what it cannot reach
///   2. then by route state: healthy, degraded, unverified, unknown
///   3. then by measured latency; a gateway that was never measured sorts after
///      measured ones in the same class, because an unknown number is not a
///      good number
///   4. then by the order the control plane returned them in, which is its own
///      priority, and finally by key so the result is deterministic
///
/// Switching servers costs every open connection, so `pick` keeps the current
/// one unless the alternative is better in a way a person would notice: a
/// better health class, or at least `minImprovementMs` faster. Without that
/// hysteresis a pair of gateways a few milliseconds apart would swap places on
/// every refresh.
public enum ServerPicker {

    /// Below this, a latency difference is noise, not an improvement.
    public static let minImprovementMs: Int64 = 40

    public static func rank(
        _ servers: [Server], probes: [String: Probe] = [:]
    ) -> [Server] {
        // The comparison is written as a tuple of keys rather than a chain of
        // comparators: Swift sorts with one predicate, and a hand-rolled chain
        // of `if` returns is where an ordering quietly stops being a strict
        // weak ordering.
        func key(_ pair: (offset: Int, element: Server)) -> (Int, Int, Int, Int64, Int, String) {
            let server = pair.element
            let probe = probes[server.key]
            return (
                probe?.failed == true ? 1 : 0,
                server.routeState.rank,
                probe?.reachable == true ? 0 : 1,
                probe?.rttMs ?? Int64.max,
                pair.offset,
                server.key
            )
        }
        return Array(servers.enumerated())
            .sorted { key($0) < key($1) }
            .map(\.element)
    }

    /// - Parameter current: the server in use, if any. Returns it unchanged
    ///   unless another one is materially better, or it is no longer offered or
    ///   reachable.
    public static func pick(
        _ servers: [Server], probes: [String: Probe] = [:], current: String? = nil
    ) -> Server? {
        let ranked = rank(servers, probes: probes)
        guard let best = ranked.first else { return nil }
        guard let inUse = servers.first(where: { $0.key == current }) else { return best }

        // A server that stopped answering, or that the control plane no longer
        // calls usable, is not worth defending.
        if probes[inUse.key]?.failed == true { return best }
        if best.routeState.rank < inUse.routeState.rank { return best }
        if best.routeState.rank > inUse.routeState.rank { return inUse }

        guard let bestRtt = probes[best.key]?.rttMs else { return inUse }
        guard let currentRtt = probes[inUse.key]?.rttMs else { return best }
        return currentRtt - bestRtt >= minImprovementMs ? best : inUse
    }

    /// The order to try when connecting: the pick first, then the rest as
    /// fallbacks. Failover walks this list, so a gateway that failed its
    /// measurement is still in it — last — rather than being thrown away: a
    /// refused handshake on one port is not proof the server is gone.
    ///
    /// `endToEnd` is the stronger evidence, when there is any: a round trip
    /// made *through* a gateway, in milliseconds, or nil for one that was tried
    /// and did not answer. A first-hop handshake says the gateway is reachable;
    /// only this says the gateway can still reach the internet. So anything
    /// proven end to end goes first, ordered by that number; servers nobody
    /// could test follow in their ordinary rank; and a server that failed the
    /// end-to-end test goes last, behind even the untested ones.
    public static func connectOrder(
        _ servers: [Server],
        probes: [String: Probe] = [:],
        endToEnd: [String: Int64?] = [:],
        current: String? = nil
    ) -> [Server] {
        let ranked = rank(servers, probes: probes)
        if endToEnd.isEmpty {
            guard let chosen = pick(servers, probes: probes, current: current) else { return [] }
            return [chosen] + ranked.filter { $0.key != chosen.key }
        }

        // `endToEnd[key]` is doubly optional: absent means untested, present
        // and nil means tested and silent. Collapsing the two would put a
        // gateway that failed ahead of one nobody could ask.
        let proven = ranked
            .filter { (endToEnd[$0.key] ?? nil) != nil }
            .sorted { (endToEnd[$0.key] ?? nil)! < (endToEnd[$1.key] ?? nil)! }
        let untested = ranked.filter { endToEnd.index(forKey: $0.key) == nil }
        let failed = ranked.filter {
            endToEnd.index(forKey: $0.key) != nil && (endToEnd[$0.key] ?? nil) == nil
        }

        let order = proven + untested + failed
        guard let head = order.first else { return [] }

        // Same hysteresis as pick(), on the numbers that were actually measured
        // here: keep the server in use unless the alternative is materially
        // faster end to end.
        let currentServer = order.first { $0.key == current }
        let currentDelay = current.flatMap { endToEnd[$0] ?? nil }
        let headDelay = endToEnd[head.key] ?? nil
        if let currentServer, let currentDelay, let headDelay,
           currentDelay - headDelay < minImprovementMs {
            return [currentServer] + order.filter { $0.key != currentServer.key }
        }
        return order
    }
}
