import Foundation

/// Base64, by hand, for the places this app meets it: a subscription blob and
/// the credential inside an `ss://` line.
///
/// Written out rather than taken from Foundation because of what arrives here.
/// `Data(base64Encoded:)` refuses a string whose padding is missing and refuses
/// the URL-safe alphabet outright, and the subscription endpoints of the world
/// disagree about both — the person pasting one has no idea which they were
/// handed. Normalising into Foundation would be most of this file anyway.
enum Base64Text {

    private static let alphabet = Array(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    )

    private static let index: [Character: Int] = {
        var map: [Character: Int] = [:]
        for (position, character) in alphabet.enumerated() { map[character] = position }
        return map
    }()

    /// The decoded text, or nil when `text` is not base64 at all.
    static func decode(_ text: String) -> String? {
        var normalised = text.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while normalised.hasSuffix("=") { normalised.removeLast() }
        if normalised.isEmpty { return nil }

        var bytes: [UInt8] = []
        bytes.reserveCapacity(normalised.count * 3 / 4 + 3)
        var buffer = 0
        var bits = 0
        for character in normalised {
            guard let value = index[character] else { return nil }
            buffer = (buffer << 6) | value
            bits += 6
            if bits >= 8 {
                bits -= 8
                bytes.append(UInt8((buffer >> bits) & 0xFF))
            }
        }
        if bytes.isEmpty { return nil }
        return String(decoding: bytes, as: UTF8.self)
    }
}
