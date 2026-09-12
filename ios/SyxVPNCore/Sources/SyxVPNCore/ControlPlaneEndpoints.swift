import Foundation

/// The addresses the control plane can be reached at, in the order to try them.
///
/// One name was a single point of failure for every phone that had already
/// installed the app: the day it is filtered, no installation can sign in,
/// fetch a subscription or learn about a new gateway — and no fix can be
/// delivered, because delivering the fix needs the same name. DNS-over-HTTPS
/// answers a resolver that will not answer; it does nothing about a name that
/// is blocked outright. Only a second name does.
///
/// The build supplies the list. This decides the order, remembers which one
/// worked so the cost of a dead first entry is paid once rather than on every
/// request, and moves on when one stops answering.
public final class ControlPlaneEndpoints {
    /// Cleaned at construction: blanks dropped, trailing slashes removed so
    /// paths concatenate without doubling, and duplicates collapsed while
    /// keeping the configured order.
    private let all: [String]
    private let remembered: () -> String?
    private let remember: (String?) -> Void

    /// - Parameters:
    ///   - configured: the hosts from the build, most preferred first.
    ///   - remembered: reads the last host known to work, or nil.
    ///   - remember: stores a host that has just worked, or clears it with nil.
    public init(
        configured: [String],
        remembered: @escaping () -> String?,
        remember: @escaping (String?) -> Void
    ) {
        var seen = Set<String>()
        var cleaned: [String] = []
        for entry in configured {
            let trimmed = entry.trimmed.withoutTrailingSlash
            if trimmed.isEmpty { continue }
            if seen.insert(trimmed).inserted { cleaned.append(trimmed) }
        }
        precondition(!cleaned.isEmpty, "a control plane needs at least one address")
        self.all = cleaned
        self.remembered = remembered
        self.remember = remember
    }

    /// Every address, preferred first: the remembered one, then the rest.
    public func ordered() -> [String] {
        guard let stored = remembered()?.withoutTrailingSlash, all.contains(stored) else {
            return all
        }
        return [stored] + all.filter { $0 != stored }
    }

    /// The one to use first.
    public func current() -> String { ordered()[0] }

    /// Records that `base` answered, so the next launch starts there.
    public func worked(_ base: String) {
        let cleaned = base.withoutTrailingSlash
        if all.contains(cleaned) && cleaned != remembered() { remember(cleaned) }
    }

    /// Records that `base` could not be reached.
    ///
    /// Only the memory is cleared, never the list: an address that fails today
    /// is the one that works tomorrow, and a censor's block is not a reason to
    /// forget an address permanently.
    public func failed(_ base: String) {
        if base.withoutTrailingSlash == remembered() { remember(nil) }
    }

    /// Rewrites `url` onto `base` when it points at one of the known hosts.
    ///
    /// A subscription link is absolute and was issued by whichever address was
    /// reachable when it was made. If that one has since gone dark the link is
    /// dead too, though the same path is served by every address — so the host
    /// is swapped and the path kept. A link pointing somewhere else entirely is
    /// left alone: someone else's subscription is not ours to redirect.
    public func rebase(_ url: String, onto base: String) -> String {
        guard let host = all.first(where: { url.hasPrefix($0 + "/") || url == $0 }) else {
            return url
        }
        return base.withoutTrailingSlash + String(url.dropFirst(host.count))
    }

    /// Splits the build's comma-separated list.
    public static func parse(_ value: String) -> [String] {
        value.components(separatedBy: ",")
    }
}

extension String {
    var withoutTrailingSlash: String {
        var out = self
        while out.hasSuffix("/") { out.removeLast() }
        return out
    }
}
