import Foundation

/// Which gateway the tunnel connects through, and in what order it falls back.
///
/// The rule this engine is built on: **evidence outranks scoring**. A round
/// trip made *through* a gateway proves the far half of the path; a handshake
/// to it proves only the first hop; a score is an opinion about numbers. So
/// candidates are put in three tiers first, and the score only decides the
/// order *within* a tier:
///
///   1. proven end to end — a request came back through this gateway
///   2. untested — nothing was measured through it, one way or the other
///   3. failed — it was tried and did not answer, at either hop
///
/// Inside a tier the score is `Purpose`'s weights applied to four signals: the
/// control plane's view of the gateway, the round trip, how steady that round
/// trip has been on this phone, and how often connecting has worked.
///
/// It is deterministic and it is arithmetic — no model, no network call,
/// nothing that can be slow at the moment someone presses ON. The signals are
/// the extension point: a richer one (packet loss, per-gateway load, a second
/// transport) enters as another term, and the tiers and the shape stay.
///
/// This is the VPN side only. Configs are chosen by the person who imported
/// them, and nothing here is applied to that list.
public enum SmartConnect {

    /// A challenger must beat the connected gateway by this much before the
    /// tunnel moves. Every switch costs every open connection, so a score that
    /// is barely better is not better.
    public static let minScoreGain = 0.05

    /// The round trip at which the latency term is worth half.
    private static let latencyReferenceMs = 150.0

    /// The jitter at which the stability term is worth half.
    private static let jitterReferenceMs = 40.0

    /// A number nobody measured is not a good number, and not a disqualifying one.
    private static let unmeasuredLatency = 0.35
    private static let unmeasuredStability = 0.5

    /// One candidate, and why it sits where it does.
    public struct Scored {
        public let server: Server
        public let score: Double
        public let tier: Int
        public let rttMs: Int64?
    }

    /// The score for one gateway, between 0 and 1.
    ///
    /// - Parameter endToEnd: milliseconds measured through this gateway, nil
    ///   when it was tried and failed or was never tried at all.
    public static func score(
        _ server: Server,
        probe: Probe? = nil,
        endToEnd: Int64? = nil,
        stats: ServerStats? = nil,
        weights: Weights = Purpose.auto.weights
    ) -> Double {
        let health: Double
        switch server.routeState {
        case .healthy: health = 1.0
        case .degraded: health = 0.5
        // "Never proven" is worse than "not reported": the control plane is
        // saying something about this gateway, and it is not good news.
        case .unverified: health = 0.3
        case .unknown: health = 0.45
        }

        // End to end when there is one, because it covers the whole path.
        let rtt = endToEnd ?? probe?.rttMs
        let latency = rtt.map { 1.0 / (1.0 + Double($0) / latencyReferenceMs) } ?? unmeasuredLatency

        let stability = stats?.jitterMs.map { 1.0 / (1.0 + $0 / jitterReferenceMs) }
            ?? unmeasuredStability

        let reliability = stats?.reliability ?? 0.5

        return weights.health * health
            + weights.latency * latency
            + weights.stability * stability
            + weights.reliability * reliability
    }

    /// Every candidate, scored and tiered, best first.
    ///
    /// Ties break on the order the control plane returned them in — that order
    /// is its own priority — and then on the key, so the same inputs always give
    /// the same list.
    public static func rank(
        _ servers: [Server],
        probes: [String: Probe] = [:],
        endToEnd: [String: Int64?] = [:],
        memory: ConnectionMemory = .empty,
        purpose: Purpose = .auto
    ) -> [Scored] {
        var entries: [(index: Int, tier: Int, scored: Scored)] = []
        for (index, server) in servers.enumerated() {
            let probe = probes[server.key]
            // Doubly optional on purpose: absent is untested, present-and-nil is
            // tested and silent, and the two sit in different tiers.
            let tested = endToEnd.index(forKey: server.key) != nil
            let measured = endToEnd[server.key] ?? nil
            let tier: Int
            if tested && measured == nil { tier = 2 }
            else if probe?.failed == true { tier = 2 }
            else if tested { tier = 0 }
            else { tier = 1 }

            entries.append((
                index,
                tier,
                Scored(
                    server: server,
                    score: score(
                        server, probe: probe, endToEnd: measured,
                        stats: memory.of(server.key), weights: purpose.weights
                    ),
                    tier: tier,
                    rttMs: measured ?? probe?.rttMs
                )
            ))
        }
        return entries.sorted { left, right in
            if left.tier != right.tier { return left.tier < right.tier }
            if left.scored.score != right.scored.score {
                return left.scored.score > right.scored.score
            }
            if left.index != right.index { return left.index < right.index }
            return left.scored.server.key < right.scored.server.key
        }.map(\.scored)
    }

    /// The order to try when connecting: the pick first, then the fallbacks.
    ///
    /// A gateway that failed its measurement stays in the list, last, rather
    /// than being thrown away — a refused handshake on one port is not proof
    /// the gateway is gone, and a list of one is not a fallback list.
    ///
    /// - Parameter current: the gateway in use, kept at the head unless a
    ///   challenger beats it by `minScoreGain` or it has dropped into a worse
    ///   tier.
    public static func connectOrder(
        _ servers: [Server],
        probes: [String: Probe] = [:],
        endToEnd: [String: Int64?] = [:],
        memory: ConnectionMemory = .empty,
        purpose: Purpose = .auto,
        current: String? = nil
    ) -> [Server] {
        let ranked = rank(servers, probes: probes, endToEnd: endToEnd, memory: memory,
                          purpose: purpose)
        guard let head = ranked.first else { return [] }
        let inUse = ranked.first { $0.server.key == current }

        let keep = inUse != nil
            && inUse!.tier <= head.tier
            && head.score - inUse!.score < minScoreGain

        guard keep, let inUse else { return ranked.map(\.server) }
        return ([inUse] + ranked.filter { $0.server.key != inUse.server.key }).map(\.server)
    }

    /// The one to connect through, which is the head of `connectOrder`.
    public static func pick(
        _ servers: [Server],
        probes: [String: Probe] = [:],
        endToEnd: [String: Int64?] = [:],
        memory: ConnectionMemory = .empty,
        purpose: Purpose = .auto,
        current: String? = nil
    ) -> Server? {
        connectOrder(servers, probes: probes, endToEnd: endToEnd, memory: memory,
                     purpose: purpose, current: current).first
    }
}
