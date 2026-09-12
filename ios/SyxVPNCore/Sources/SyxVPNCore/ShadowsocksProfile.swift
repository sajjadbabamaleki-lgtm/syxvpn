import Foundation

/// A Shadowsocks profile, in the SIP002 form.
///
/// The credential is a method and a password, and for the 2022 methods the
/// password is itself two keys joined by a colon — the inbound's and the
/// subscriber's. Nothing here needs to know that: it is one opaque string to
/// everything between the control plane that wrote it and the core that uses it.
///
/// Two encodings exist in the wild and both are accepted, because a person
/// pasting a line bought somewhere else did not choose which one they were
/// given:
///
///     ss://<base64url(method:password)>@host:port#label      (SIP002)
///     ss://<base64(method:password@host:port)>#label         (the older form)
public struct ShadowsocksProfile: TunnelProfile, Equatable {
    public let uri: String
    public let host: String
    public let port: Int
    public let label: String
    public let method: String
    public let password: String

    public var protocolLabel: String { "shadowsocks · \(method)" }

    public static func parse(_ uri: String) -> ShadowsocksProfile? {
        guard uri.hasPrefix("ss://") else { return nil }
        let withoutScheme = String(uri.dropFirst("ss://".count))
        let body = withoutScheme.before("#")
        let labelText = withoutScheme.after("#")
        let label = labelText.isEmpty ? nil : UriParts.decode(labelText)

        if body.contains("@") {
            guard let credential = decodeCredential(body.beforeLast("@")) else { return nil }
            let hostPort = body.afterLast("@").before("?")
            let host = hostPort.beforeLast(":").trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
            guard let port = Int(hostPort.afterLast(":")) else { return nil }
            guard !host.isEmpty, (1...65535).contains(port) else { return nil }
            return ShadowsocksProfile(
                uri: uri, host: host, port: port,
                label: label ?? "\(host):\(port)",
                method: credential.0, password: credential.1
            )
        }

        // The older form: everything, including the address, inside one blob.
        guard let decoded = decodeBase64(body.before("?")) else { return nil }
        guard let credential = decodeCredentialText(decoded.beforeLast("@")) else { return nil }
        let hostPort = decoded.afterLast("@")
        let host = hostPort.beforeLast(":").trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        guard let port = Int(hostPort.afterLast(":")) else { return nil }
        guard !host.isEmpty, (1...65535).contains(port) else { return nil }
        return ShadowsocksProfile(
            uri: uri, host: host, port: port,
            label: label ?? "\(host):\(port)",
            method: credential.0, password: credential.1
        )
    }

    /// The userinfo of a SIP002 line.
    ///
    /// It is usually base64, and it is sometimes not: some issuers write the
    /// method and password in the clear, and a client that only accepts one of
    /// those rejects a line that works everywhere else.
    private static func decodeCredential(_ value: String) -> (String, String)? {
        decodeCredentialText(decodeBase64(value) ?? value)
    }

    private static func decodeCredentialText(_ value: String) -> (String, String)? {
        // The password of a 2022 method contains a colon of its own, so the
        // split is on the FIRST one: everything after it is the password.
        guard value.contains(":") else { return nil }
        let method = value.before(":")
        let password = value.after(":")
        if method.isEmpty || password.isEmpty { return nil }
        return (method, password)
    }

    /// The credential blob of a `ss://` line.
    ///
    /// Anything that is not a credential is not one: the caller's split needs a
    /// colon, and garbage that happened to decode cleanly has none.
    private static func decodeBase64(_ value: String) -> String? {
        guard let decoded = Base64Text.decode(value), decoded.contains(":") else { return nil }
        return decoded
    }
}

/// The substring helpers Kotlin has and Swift does not.
///
/// `before` and `after` return "" when the separator is absent on the side that
/// would have to invent text; `beforeLast`/`afterLast` mirror Kotlin's
/// `substringBeforeLast`/`substringAfterLast`, which return the whole string
/// when there is no separator. The Shadowsocks parser leans on both behaviours.
extension String {
    func before(_ separator: Character) -> String {
        guard let i = firstIndex(of: separator) else { return self }
        return String(self[startIndex..<i])
    }

    func after(_ separator: Character) -> String {
        guard let i = firstIndex(of: separator) else { return "" }
        return String(self[index(after: i)...])
    }

    func beforeLast(_ separator: Character) -> String {
        guard let i = lastIndex(of: separator) else { return self }
        return String(self[startIndex..<i])
    }

    func afterLast(_ separator: Character) -> String {
        guard let i = lastIndex(of: separator) else { return self }
        return String(self[index(after: i)...])
    }
}
