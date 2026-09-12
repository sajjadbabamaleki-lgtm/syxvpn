import Foundation

/// One measurement of one server, taken this session.
public struct Probe: Equatable {
    public let key: String
    public let rttMs: Int64?
    public let attempted: Bool

    public init(key: String, rttMs: Int64? = nil, attempted: Bool = false) {
        self.key = key
        self.rttMs = rttMs
        self.attempted = attempted
    }

    public var reachable: Bool { rttMs != nil }
    public var failed: Bool { attempted && rttMs == nil }
}

/// How an imported config is doing — and nothing more than that.
///
/// The Configs tab is manual. This measures, it colours a dot, it shows a
/// number that was actually measured; it never selects, replaces, reorders or
/// edits a config, and no code path leads from a health result to a connection
/// decision. That separation is the point of having two tabs at all.
///
/// What is measured is a TCP handshake to the config's own host and port. It
/// says nothing about whether that server can still reach the internet — the
/// tunnel finds that out end to end, and the Configs tab does not pretend to
/// know it.
public enum ConfigHealth {
    /// Answered, promptly and steadily.
    case good
    /// Answered, but slowly, or unevenly, or not every time.
    case unstable
    /// Tried and did not answer.
    case offline
    /// Never measured on this phone. Not a verdict — an absence of one.
    case unknown

    /// Past this, a first hop is slow enough to notice.
    public static let slowMs = 600.0

    /// Past this, the round trip moves enough to be felt as stalling.
    public static let unsteadyJitterMs = 120.0

    /// Older than this, a measurement is history rather than a state.
    public static let staleAfterMs: Int64 = 15 * 60 * 1000

    /// - Parameters:
    ///   - probe: the most recent measurement, if one was taken this session.
    ///   - stats: what this phone remembers about the same server.
    ///   - now: used only to decide whether the memory is too old to speak for.
    public static func of(probe: Probe?, stats: ServerStats?, now: Int64) -> ConfigHealth {
        if probe?.failed == true { return .offline }

        var rtt: Double?
        if let measured = probe?.rttMs {
            rtt = Double(measured)
        } else if let stats, let remembered = stats.rttMs,
                  stats.updatedAt > 0, now - stats.updatedAt <= staleAfterMs {
            rtt = remembered
        }
        guard let rtt else { return .unknown }

        let unsteady = (stats?.jitterMs ?? 0) > unsteadyJitterMs
        let flaky = (stats?.consecutiveFailures ?? 0) > 0
        return (rtt > slowMs || unsteady || flaky) ? .unstable : .good
    }
}
