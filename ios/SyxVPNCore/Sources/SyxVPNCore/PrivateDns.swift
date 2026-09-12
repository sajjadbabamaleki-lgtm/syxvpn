import Foundation

/// Which resolver the tunnel uses, and whether the queries are encrypted.
///
/// A tunnel that carries the traffic but leaks the names is half a tunnel.
///
/// Each encrypted mode is a DNS-over-HTTPS endpoint, and every endpoint here is
/// addressed by IP rather than by name. A resolver reached by name needs a
/// resolver to reach it, and the query that bootstraps DNS is exactly the query
/// nobody is encrypting.
///
/// The answer never leaves the device either way: nothing here is reported, and
/// which mode is set is stored on the phone alone.
public enum PrivateDns: String, CaseIterable {
    case standard = "STANDARD"
    case cloudflare = "CLOUDFLARE"
    case google = "GOOGLE"
    case quad9 = "QUAD9"

    /// What the person picking it sees.
    public var label: String {
        switch self {
        case .standard: return "Standard"
        case .cloudflare: return "Cloudflare"
        case .google: return "Google"
        case .quad9: return "Quad9"
        }
    }

    /// One line under the label. No claim here that the resolver itself cannot
    /// see the query, because it can — encryption hides it from the path, not
    /// from the far end.
    public var detail: String {
        switch self {
        case .standard: return "Plain DNS inside the tunnel, as before"
        case .cloudflare: return "Encrypted to 1.1.1.1"
        case .google: return "Encrypted to 8.8.8.8"
        case .quad9: return "Encrypted to 9.9.9.9, and it refuses known-malicious names"
        }
    }

    /// The DoH endpoint, or nil for the plain resolvers the app used before this
    /// existed. That nil is the rollback: `.standard` generates byte for byte
    /// the configuration that shipped.
    public var dohUrl: String? {
        switch self {
        case .standard: return nil
        case .cloudflare: return "https://1.1.1.1/dns-query"
        case .google: return "https://8.8.8.8/dns-query"
        case .quad9: return "https://9.9.9.9/dns-query"
        }
    }

    /// What the tunnel interface advertises to the system. Queries to them are
    /// captured by the tunnel and re-issued over `dohUrl` when there is one, so
    /// on an encrypted mode these addresses are what the OS shows in its network
    /// details and not where the query actually goes.
    public var addresses: [String] {
        switch self {
        case .standard: return ["1.1.1.1", "8.8.8.8"]
        case .cloudflare: return ["1.1.1.1", "1.0.0.1"]
        case .google: return ["8.8.8.8", "8.8.4.4"]
        case .quad9: return ["9.9.9.9", "149.112.112.112"]
        }
    }

    /// Whether queries leave this phone as DoH rather than as clear-text UDP.
    public var encrypted: Bool { dohUrl != nil }

    /// What a phone that has never been asked gets.
    public static let `default` = PrivateDns.cloudflare

    /// The mode stored under `value`, or the default when it is missing or is a
    /// name this build does not know — a mode removed in a later version must
    /// not leave the tunnel without a resolver.
    public static func of(_ value: String?) -> PrivateDns {
        guard let value else { return .default }
        return allCases.first { $0.rawValue.caseInsensitiveCompare(value) == .orderedSame }
            ?? .default
    }
}
