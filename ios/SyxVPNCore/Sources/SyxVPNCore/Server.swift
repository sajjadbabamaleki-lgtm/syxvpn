import Foundation

/// What the control plane says about a gateway's whole path.
///
/// The rank orders them worst-last, so the worst thing said about any server in
/// a group is the group's own state.
public enum RouteState: Int, Equatable {
    case healthy = 0
    case degraded = 1
    case unverified = 2
    case unknown = 3

    public var rank: Int { rawValue }

    public static func of(_ value: String?) -> RouteState {
        switch value?.lowercased() {
        case "healthy": return .healthy
        case "degraded": return .degraded
        case "unverified": return .unverified
        default: return .unknown
        }
    }
}

/// A gateway the subscription is currently offering, with what is known about it.
public struct Server {
    public let profile: TunnelProfile
    public let routeState: RouteState
    public let gatewayName: String?
    public let region: String?
    /// Pasted in by the person rather than issued by this control plane.
    ///
    /// It changes what may be said about it and what may be done to it: no
    /// health is claimed for it beyond what this phone measured, and a refresh
    /// never removes it, because nothing here issued it and nothing here can
    /// take it back.
    public let imported: Bool

    public init(
        profile: TunnelProfile,
        routeState: RouteState = .unknown,
        gatewayName: String? = nil,
        region: String? = nil,
        imported: Bool = false
    ) {
        self.profile = profile
        self.routeState = routeState
        self.gatewayName = gatewayName
        self.region = region
        self.imported = imported
    }

    /// Stable identity of a server across refreshes.
    public var key: String { "\(profile.host):\(profile.port)" }

    /// What to call it on screen: the control plane's name for the gateway when
    /// there is one, otherwise whatever the profile labelled itself.
    public var label: String { gatewayName ?? profile.label }
}
