import Foundation

/// One way into one gateway.
///
/// What every kind promises is the same, and it is small: the FIRST HOP. A
/// profile says how to reach a gateway. It says nothing about how that gateway
/// reaches the internet, which is the control plane's business and is not
/// visible from here at all.
///
/// `parse` is the one door in. Everything that reads a line — a subscription, a
/// clipboard, a QR code somebody was sent — goes through it, so a protocol is
/// added in exactly one place and no caller has to know the list.
public protocol TunnelProfile {
    /// The original line, kept so it can be copied, shared or stored verbatim.
    var uri: String { get }
    var host: String { get }
    var port: Int { get }
    var label: String { get }

    /// What this is, in the words the connection screen shows: `vless · ws · tls`,
    /// `shadowsocks · 2022-blake3-aes-256-gcm`, `trojan · tls`.
    ///
    /// It belongs to the profile rather than to the screen. A screen that works
    /// this out from the fields has to be edited every time a protocol is added,
    /// and the one that is not edited quietly labels the new thing as the old.
    var protocolLabel: String { get }
}

public enum TunnelProfiles {
    /// The scheme of every line this app can turn into a tunnel.
    public static let schemes = ["vless://", "ss://", "trojan://"]

    /// Whether a line is worth trying to parse — not whether it will work.
    public static func looksLikeProfile(_ line: String) -> Bool {
        schemes.contains { line.hasPrefix($0) }
    }

    public static func parse(_ line: String) -> TunnelProfile? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("vless://") { return VlessProfile.parse(trimmed) }
        if trimmed.hasPrefix("ss://") { return ShadowsocksProfile.parse(trimmed) }
        if trimmed.hasPrefix("trojan://") { return TrojanProfile.parse(trimmed) }
        return nil
    }
}
