import Foundation

/// Just enough URI parsing to read a `vless://` line, written by hand.
///
/// `URL` and `URLComponents` would be the obvious choice and are the wrong one:
/// both are strict about characters these links carry all the time. The
/// fragment on a real profile is a human-readable label — spaces, "·", Persian
/// — usually not percent-encoded, and `URL(string:)` returns nil on it. A
/// profile that fails to parse is a server the person paid for and cannot see.
///
/// Decoding keeps one convention people get wrong: `+` is a literal plus, not
/// a space. That belongs to HTML form encoding, and a WebSocket path of
/// `/ws+1` is a real path.
struct UriParts: Equatable {
    let scheme: String
    let userInfo: String?
    let host: String?
    let port: Int?
    let query: [String: String]
    let fragment: String?

    func param(_ name: String) -> String? { query[name] }

    static func parse(_ raw: String) -> UriParts? {
        guard let schemeRange = raw.range(of: "://"), schemeRange.lowerBound != raw.startIndex else {
            return nil
        }
        let scheme = String(raw[raw.startIndex..<schemeRange.lowerBound]).lowercased()
        var rest = String(raw[schemeRange.upperBound...])

        // Fragment first, then query: both are cut from the right, and a label
        // is free to contain '?' — "Berlin · fast?" is a label.
        var fragment: String?
        if let hash = rest.firstIndex(of: "#") {
            fragment = percentDecode(String(rest[rest.index(after: hash)...]))
            rest = String(rest[rest.startIndex..<hash])
        }

        var query: [String: String] = [:]
        if let mark = rest.firstIndex(of: "?") {
            query = parseQuery(String(rest[rest.index(after: mark)...]))
            rest = String(rest[rest.startIndex..<mark])
        }

        // The last '@', not the first: a userinfo may contain one encoded, and
        // the host never does.
        var userInfo: String?
        if let at = rest.lastIndex(of: "@") {
            let decoded = percentDecode(String(rest[rest.startIndex..<at]))
            userInfo = decoded.isEmpty ? nil : decoded
            rest = String(rest[rest.index(after: at)...])
        }

        guard let (host, port) = splitHostPort(rest) else { return nil }
        return UriParts(
            scheme: scheme, userInfo: userInfo, host: host,
            port: port, query: query, fragment: fragment
        )
    }

    /// `host:port`, `[v6]:port`, or either without a port.
    private static func splitHostPort(_ authority: String) -> (String?, Int?)? {
        if authority.isEmpty { return nil }
        if authority.hasPrefix("[") {
            guard let close = authority.firstIndex(of: "]") else { return nil }
            let host = String(authority[authority.index(after: authority.startIndex)..<close])
            let tail = String(authority[authority.index(after: close)...])
            if tail.isEmpty { return (host, nil) }
            guard tail.hasPrefix(":") else { return nil }
            guard let port = Int(tail.dropFirst()) else { return nil }
            return (host, port)
        }
        guard let colon = authority.lastIndex(of: ":") else { return (authority, nil) }
        // More than one colon and no brackets is a bare IPv6 address, which is
        // not a thing a URI authority may hold.
        if authority.firstIndex(of: ":") != colon { return nil }
        let host = String(authority[authority.startIndex..<colon])
        if host.isEmpty { return nil }
        guard let port = Int(authority[authority.index(after: colon)...]) else { return nil }
        return (host, port)
    }

    /// Percent-decoding on its own, for the schemes that are not URIs: a
    /// Shadowsocks line's label is encoded the same way, but everything before
    /// it is base64 and has no business going through a URI parser.
    static func decode(_ value: String) -> String { percentDecode(value) }

    /// First value wins.
    private static func parseQuery(_ raw: String) -> [String: String] {
        var out: [String: String] = [:]
        for pair in raw.split(separator: "&", omittingEmptySubsequences: true) {
            let text = String(pair)
            let name: String
            let value: String
            if let eq = text.firstIndex(of: "=") {
                name = percentDecode(String(text[text.startIndex..<eq]))
                value = percentDecode(String(text[text.index(after: eq)...]))
            } else {
                name = percentDecode(text)
                value = ""
            }
            if !name.isEmpty && out[name] == nil { out[name] = value }
        }
        return out
    }

    /// %XX only.
    ///
    /// Consecutive escapes are gathered and read as UTF-8 together: one Persian
    /// character is two escapes and a flag emoji is eight, and decoding them one
    /// at a time produces mojibake rather than a label.
    ///
    /// Anything that is not a valid escape is left as written rather than
    /// dropped: a stray '%' in a label is a '%'.
    static func percentDecode(_ raw: String) -> String {
        if !raw.contains("%") { return raw }
        var out = ""
        var pending: [UInt8] = []
        func flush() {
            if pending.isEmpty { return }
            out += String(decoding: pending, as: UTF8.self)
            pending.removeAll(keepingCapacity: true)
        }
        let characters = Array(raw)
        var i = 0
        while i < characters.count {
            if characters[i] == "%", i + 2 < characters.count,
               let value = UInt8(String(characters[(i + 1)...(i + 2)]), radix: 16) {
                pending.append(value)
                i += 3
                continue
            }
            flush()
            out.append(characters[i])
            i += 1
        }
        flush()
        return out
    }
}
