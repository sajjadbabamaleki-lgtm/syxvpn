import Foundation

/// Reading configs a person pasted in, from wherever they got them.
///
/// A config bought from somebody else is theirs. It needs no plan, no account
/// and no subscription here — and supporting it is not a courtesy: somebody
/// with a working config from another provider will install the app that reads
/// it, and that is the app whose other tab they see when their config stops
/// working.
///
/// What people actually paste is not one shape. It is a line, or forty lines,
/// or the base64 blob a subscription URL answers with, or all of that with a
/// comment line and some blank ones through the middle. Every one of those is
/// accepted, because the alternative is a person who has the right thing in
/// their clipboard being told it is wrong.
public enum ConfigImport {

    public struct Result {
        /// Parsed and not already held, in the order they were pasted.
        public let added: [TunnelProfile]
        /// Lines that looked like configs and could not be read.
        public let rejected: Int
        /// Lines that were already in the list.
        public let duplicates: Int

        public var isEmpty: Bool { added.isEmpty }

        /// What to tell the person, in their terms rather than the parser's.
        public func summary() -> String {
            if added.isEmpty && rejected == 0 && duplicates > 0 {
                return duplicates == 1
                    ? "You already have that one"
                    : "You already have all \(duplicates)"
            }
            if added.isEmpty && rejected > 0 {
                return rejected == 1
                    ? "That does not look like a config"
                    : "None of those \(rejected) could be read"
            }
            if added.isEmpty { return "Nothing to add" }
            var out = added.count == 1 ? "Added 1 config" : "Added \(added.count) configs"
            if duplicates > 0 { out += ", \(duplicates) already here" }
            if rejected > 0 { out += ", \(rejected) could not be read" }
            return out
        }
    }

    /// - Parameter existing: URIs already held, so pasting the same list twice
    ///   does not double it — which is what happens when somebody re-copies
    ///   from a channel to get one new server.
    public static func parse(_ pasted: String, existing: [String] = []) -> Result {
        var held = Set(existing)
        var added: [TunnelProfile] = []
        var rejected = 0
        var duplicates = 0

        for line in candidates(pasted) {
            guard let profile = TunnelProfiles.parse(line) else {
                rejected += 1
                continue
            }
            if !held.insert(profile.uri).inserted {
                duplicates += 1
                continue
            }
            added.append(profile)
        }
        return Result(added: added, rejected: rejected, duplicates: duplicates)
    }

    /// The lines worth trying, from whatever was pasted.
    ///
    /// A subscription URL answers with base64 of the whole list, and people
    /// paste that answer as often as they paste the links themselves — so a
    /// blob that decodes into config lines is unwrapped once. Once, not
    /// repeatedly: base64 of base64 is not a format anybody produces, and
    /// following it forever is a way to hang on a large paste.
    private static func candidates(_ pasted: String) -> [String] {
        let direct = lines(pasted)
        if direct.contains(where: { TunnelProfiles.looksLikeProfile($0) }) { return direct }

        let blob = pasted.filter { !$0.isWhitespace }
        // Short strings decode into noise as readily as into a list, and a
        // subscription answer is never eight characters long.
        guard blob.count >= 8, let decoded = Base64Text.decode(blob) else { return direct }
        let fromBlob = lines(decoded)
        return fromBlob.contains(where: { TunnelProfiles.looksLikeProfile($0) })
            ? fromBlob : direct
    }

    private static func lines(_ text: String) -> [String] {
        // `isNewline`, not a comparison against "\n" and "\r" separately. In
        // Swift a Character is a grapheme cluster and CRLF is one of them, so it
        // equals neither — and text copied out of a chat app on Windows is
        // mostly CRLF. Splitting it that way left the whole paste as a single
        // line, which parsed as one config and silently dropped the rest.
        text.split(whereSeparator: \.isNewline)
            .map { $0.trimmed }
            // A '#' line is a comment in some lists, but a config's own label
            // comes after a '#' *within* the line, so only a leading one is a
            // comment.
            .filter { !$0.isEmpty && !$0.hasPrefix("#") && !$0.hasPrefix("//") }
    }
}
