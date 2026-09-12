import Foundation

/// A parsed `vless://` profile.
///
/// This is the FIRST HOP only: it says how to reach a gateway, and nothing
/// about how that gateway reaches the internet. Route selection happens in the
/// control plane; the client simply uses whichever gateways the subscription
/// currently hands out.
public struct VlessProfile: TunnelProfile, Equatable {
    /// What a client needs to be recognised by a REALITY gateway.
    ///
    /// The public key and the short ID are what separate a subscriber from a
    /// censor's prober: without them the gateway forwards the connection to the
    /// borrowed site, and the prober gets that site's real certificate back.
    public struct Reality: Equatable {
        public let publicKey: String
        public let shortId: String
        public let serverName: String
        public let fingerprint: String
        /// Vision. It shapes packets like a browser's; REALITY without it is
        /// thinner cover.
        public let flow: String
    }

    /// The original `vless://` line, kept so it can be copied or shared.
    public let uri: String
    public let uuid: String
    public let host: String
    public let port: Int
    public let label: String
    public let tls: Bool
    public let sni: String?
    public let wsPath: String
    public let wsHost: String?
    /// REALITY, when the gateway borrows a real site's TLS handshake instead of
    /// serving a certificate of its own. Nil on a WebSocket profile, which is
    /// every profile issued before this existed.
    public let reality: Reality?

    public var protocolLabel: String {
        if reality != nil { return "vless · tcp · reality" }
        return tls ? "vless · ws · tls" : "vless · ws"
    }

    public static func parse(_ uri: String) -> VlessProfile? {
        guard uri.hasPrefix("vless://") else { return nil }
        guard let parsed = UriParts.parse(uri) else { return nil }
        guard let uuid = parsed.userInfo else { return nil }
        guard let host = parsed.host, !host.isEmpty else { return nil }
        guard let port = parsed.port, (1...65535).contains(port) else { return nil }
        let security = parsed.param("security") ?? "none"
        let type = parsed.param("type") ?? "ws"

        if security == "reality" {
            // REALITY runs over plain TCP here, and its public key is the one
            // thing that cannot be defaulted: without it there is nothing to
            // encrypt to.
            guard type == "tcp" else { return nil }
            guard let publicKey = parsed.param("pbk"), !publicKey.trimmed.isEmpty else { return nil }
            return VlessProfile(
                uri: uri,
                uuid: uuid,
                host: host,
                port: port,
                label: parsed.fragment ?? host,
                tls: true,
                sni: parsed.param("sni"),
                wsPath: "/",
                wsHost: nil,
                reality: Reality(
                    publicKey: publicKey,
                    shortId: parsed.param("sid") ?? "",
                    // The name claimed in the handshake: the borrowed site's,
                    // never the gateway's own address.
                    serverName: parsed.param("sni") ?? host,
                    fingerprint: parsed.param("fp") ?? "chrome",
                    flow: parsed.param("flow") ?? "xtls-rprx-vision"
                )
            )
        }

        // Otherwise ws, which is all the control plane generated before
        // REALITY; anything else is rejected rather than misconfigured.
        guard type == "ws" else { return nil }
        return VlessProfile(
            uri: uri,
            uuid: uuid,
            host: host,
            port: port,
            label: parsed.fragment ?? host,
            tls: security == "tls",
            sni: parsed.param("sni"),
            wsPath: parsed.param("path") ?? "/ws",
            wsHost: parsed.param("host"),
            reality: nil
        )
    }
}

/// On StringProtocol rather than String: `split` hands back Substrings, and an
/// extension that only covered String meant every such call site had to convert
/// first or stop compiling.
extension StringProtocol {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
