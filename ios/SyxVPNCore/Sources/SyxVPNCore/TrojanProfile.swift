import Foundation

/// A Trojan profile.
///
/// Trojan is defined over TLS and has no meaning without it: the disguise is
/// that a wrong password gets the web server behind it rather than an error,
/// and there is no web server without a certificate. So `security` is not read
/// as a switch here — a line that says `security=none` is a line that cannot
/// work, and is refused rather than turned into a tunnel that fails on the
/// phone.
public struct TrojanProfile: TunnelProfile, Equatable {
    public let uri: String
    public let host: String
    public let port: Int
    public let label: String
    public let password: String
    /// The name to claim in the handshake; the certificate has to carry it.
    public let sni: String
    /// Which browser's ClientHello to imitate, when the core supports it.
    public let fingerprint: String?

    public var protocolLabel: String { "trojan · tls" }

    public static func parse(_ uri: String) -> TrojanProfile? {
        guard uri.hasPrefix("trojan://") else { return nil }
        guard let parts = UriParts.parse(uri) else { return nil }
        guard let password = parts.userInfo, !password.isEmpty else { return nil }
        guard let host = parts.host, !host.isEmpty else { return nil }
        guard let port = parts.port, (1...65535).contains(port) else { return nil }
        // Absent means TLS: every trojan line that predates the parameter is
        // TLS, because the protocol has never been anything else.
        let security = parts.param("security") ?? "tls"
        guard security == "tls" else { return nil }
        let sni = parts.param("sni").flatMap { $0.trimmed.isEmpty ? nil : $0 } ?? host
        let fingerprint = parts.param("fp").flatMap { $0.trimmed.isEmpty ? nil : $0 }
        return TrojanProfile(
            uri: uri, host: host, port: port,
            label: parts.fragment ?? "\(host):\(port)",
            password: password, sni: sni, fingerprint: fingerprint
        )
    }
}
