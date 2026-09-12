import Foundation

/// How much each signal counts, per purpose. The four are meant to sum to 1, so
/// a score is comparable between purposes; `PurposeTests` holds them to it.
///
/// - `health`: what the control plane says about the gateway's whole path — the
///   only signal that covers the half of the path the phone cannot see.
/// - `latency`: the round trip, end to end where it was measured through the
///   gateway, otherwise the first hop.
/// - `stability`: how much that round trip moves about, from this phone's own
///   history with the gateway.
/// - `reliability`: how often connecting to it has actually worked.
public struct Weights: Equatable {
    public let health: Double
    public let latency: Double
    public let stability: Double
    public let reliability: Double

    public var sum: Double { health + latency + stability + reliability }
}

/// What the person is using the tunnel for, and what that changes.
///
/// This is not a filter over the server list and it is not decoration: a purpose
/// is a set of weights, and the weights are what `SmartConnect` scores servers
/// with. Two purposes will genuinely pick different gateways out of the same
/// list — Gaming takes the lowest round trip even from a gateway that failed
/// once this week, Social takes the gateway that has never failed even when it
/// is 60 ms further away.
///
/// Adding a purpose is adding a case: nothing else in the engine knows the
/// names, only the weights.
public enum Purpose: String, CaseIterable {
    /// No stated preference: every signal counts, none dominates.
    case auto = "AUTO"

    /// Messaging and social apps. These are small, frequent requests where a
    /// connection that works every time beats one that is quick when it works,
    /// so a gateway's own record carries the most weight.
    case social = "SOCIAL"

    /// Video. A stream fills a buffer and then lives off it, so 40 ms more on
    /// the round trip is invisible while a gateway that stalls is not:
    /// steadiness outranks speed here.
    case streaming = "STREAMING"

    /// Games. The round trip *is* the experience, and a jittery path is worse
    /// than a slower steady one, so those two take most of the weight.
    case gaming = "GAMING"

    public var label: String {
        switch self {
        case .auto: return "Auto"
        case .social: return "Social"
        case .streaming: return "Streaming"
        case .gaming: return "Gaming"
        }
    }

    public var weights: Weights {
        switch self {
        case .auto:
            return Weights(health: 0.35, latency: 0.25, stability: 0.20, reliability: 0.20)
        case .social:
            return Weights(health: 0.30, latency: 0.20, stability: 0.15, reliability: 0.35)
        case .streaming:
            return Weights(health: 0.25, latency: 0.15, stability: 0.35, reliability: 0.25)
        case .gaming:
            return Weights(health: 0.15, latency: 0.45, stability: 0.30, reliability: 0.10)
        }
    }

    public static func of(_ value: String?) -> Purpose {
        guard let value else { return .auto }
        return allCases.first { $0.rawValue.caseInsensitiveCompare(value) == .orderedSame } ?? .auto
    }
}
