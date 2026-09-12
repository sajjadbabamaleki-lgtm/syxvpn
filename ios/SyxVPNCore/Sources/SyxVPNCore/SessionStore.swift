import Foundation

/// Where the session's values are actually kept.
///
/// Behind a protocol for one practical reason and one design one. The practical
/// one: the Keychain needs an entitlement and a signed host application, so a
/// store nailed to it could not be tested by `swift test` at all. The design
/// one: the tunnel extension and the app are different processes reading the
/// same values, and which container they share is a decision for the app
/// target, not for this file.
public protocol SessionStorage: AnyObject {
    func string(_ key: String) -> String?
    func setString(_ key: String, _ value: String?)
    func bool(_ key: String, default fallback: Bool) -> Bool
    func setBool(_ key: String, _ value: Bool)
    func removeAll()
}

/// The keys whose values are bearer secrets.
///
/// A backend that can offer two levels of protection — Keychain for these,
/// ordinary preferences for the rest — reads this rather than guessing. The
/// subscription URL is on the list: on its own it is enough to use the account.
public enum SessionSecrets {
    public static let keys: Set<String> = ["token", "subscription_url", "profiles"]
}

/// A store with no persistence, for tests.
public final class InMemorySessionStorage: SessionStorage {
    private var values: [String: String] = [:]
    private var flags: [String: Bool] = [:]

    public init() {}

    public func string(_ key: String) -> String? { values[key] }
    public func setString(_ key: String, _ value: String?) {
        if let value { values[key] = value } else { values.removeValue(forKey: key) }
    }
    public func bool(_ key: String, default fallback: Bool) -> Bool { flags[key] ?? fallback }
    public func setBool(_ key: String, _ value: Bool) { flags[key] = value }
    public func removeAll() { values.removeAll(); flags.removeAll() }
}

/// Holds the customer session token, the last known subscription URL, and the
/// settings the person has chosen.
///
/// The token and the subscription URL are bearer secrets: whoever holds either
/// can use the account. Which store keeps them is the backend's business; that
/// they are named as secrets is this file's.
public final class SessionStore {

    private enum Key {
        static let token = "token"
        static let email = "email"
        static let subscriptionUrl = "subscription_url"
        static let profiles = "profiles"
        static let hidden = "hidden_configs"
        static let imported = "imported_configs"
        static let automatic = "automatic_server"
        static let country = "country"
        static let purpose = "purpose"
        static let memory = "connection_memory"
        static let controlBase = "control_plane_base"
        static let dns = "dns_mode"
    }

    private let storage: SessionStorage

    /// Whether this build offers encrypted DNS at all.
    ///
    /// It gates the mode outright rather than only setting the default: a build
    /// with the flag off has to behave exactly like the build before the
    /// feature, including for the phone of somebody who had already picked an
    /// encrypted mode. That is what makes it a switch that can be thrown back.
    private let privateDnsEnabled: Bool

    public init(storage: SessionStorage, privateDnsEnabled: Bool = true) {
        self.storage = storage
        self.privateDnsEnabled = privateDnsEnabled
    }

    public var token: String? {
        get { storage.string(Key.token) }
        set { storage.setString(Key.token, newValue) }
    }

    /// Whether there is a session at all. A fresh install has none, and that is
    /// fine — the tunnel does not need one.
    public var signedIn: Bool { token != nil }

    public var email: String? {
        get { storage.string(Key.email) }
        set { storage.setString(Key.email, newValue) }
    }

    public var subscriptionUrl: String? {
        get { storage.string(Key.subscriptionUrl) }
        set { storage.setString(Key.subscriptionUrl, newValue) }
    }

    /// Last profile list fetched from the subscription, newline separated.
    public var cachedProfiles: String? {
        get { storage.string(Key.profiles) }
        set { storage.setString(Key.profiles, newValue) }
    }

    /// Configs the person pasted in themselves, newline separated.
    ///
    /// These are not a subscription and are nobody's to revoke: a config bought
    /// from another provider belongs to whoever bought it, so it survives
    /// signing out, an expired plan, and never having had one. Only removing it
    /// here removes it.
    public var importedConfigs: String? {
        get { storage.string(Key.imported) }
        set { storage.setString(Key.imported, newValue) }
    }

    /// The pasted configs as lines, in the order they were added.
    public var importedLines: [String] {
        (importedConfigs ?? "")
            .split(omittingEmptySubsequences: true, whereSeparator: \.isNewline)
            .map { $0.trimmed }
            .filter { !$0.isEmpty }
    }

    public func addImported(_ uris: [String]) {
        if uris.isEmpty { return }
        importedConfigs = (importedLines + uris).joined(separator: "\n")
    }

    public func removeImported(_ uri: String) {
        let kept = importedLines.filter { $0 != uri }.joined(separator: "\n")
        importedConfigs = kept.isEmpty ? nil : kept
    }

    /// Servers the person chose to hide, as "host:port" entries.
    ///
    /// A subscription decides which servers exist, so hiding is local and
    /// sticky: a refresh brings the server back from the control plane but it
    /// stays out of the list until it is unhidden here.
    public var hiddenConfigs: Set<String> {
        get {
            Set((storage.string(Key.hidden) ?? "")
                .split(separator: "\n", omittingEmptySubsequences: true)
                .map(String.init))
        }
        set {
            // Sorted, so the same set always writes the same bytes.
            storage.setString(
                Key.hidden, newValue.isEmpty ? nil : newValue.sorted().joined(separator: "\n")
            )
        }
    }

    /// Which resolver the tunnel uses.
    ///
    /// Stored by name, read back through `PrivateDns.of`, so a name this build
    /// does not know reads as the default rather than as no resolver at all.
    public var dnsMode: PrivateDns {
        get {
            guard privateDnsEnabled else { return .standard }
            return PrivateDns.of(storage.string(Key.dns))
        }
        set { storage.setString(Key.dns, newValue.rawValue) }
    }

    /// Whether the tunnel chooses the config, rather than the person.
    ///
    /// On by default: someone who has just bought a plan has no way to know
    /// which gateway is best for their network, and the tunnel can measure it.
    public var automaticServer: Bool {
        get { storage.bool(Key.automatic, default: true) }
        set { storage.setBool(Key.automatic, newValue) }
    }

    /// ISO code of the country automatic selection is limited to, or nil for
    /// anywhere.
    public var country: String? {
        get { storage.string(Key.country) }
        set { storage.setString(Key.country, newValue) }
    }

    /// What the person said they use the VPN for, as a `Purpose` name. It
    /// changes how automatic selection weighs its signals, and nothing else.
    public var purposeName: String? {
        get { storage.string(Key.purpose) }
        set { storage.setString(Key.purpose, newValue) }
    }

    public var purpose: Purpose { Purpose.of(purposeName) }

    /// What this phone has learned about each gateway, encoded by
    /// `ConnectionMemory`.
    ///
    /// It holds host:port, counters and timings — no credential and no profile
    /// line — but which gateways a phone has been talking to is not public
    /// either, so it goes wherever the rest of this does.
    public var connectionMemory: String? {
        get { storage.string(Key.memory) }
        set { storage.setString(Key.memory, newValue) }
    }

    /// The control-plane address that last answered.
    ///
    /// Kept so a first entry that has gone dark costs one failed connection at
    /// launch rather than one on every request. It is a hint, not a setting:
    /// the build's list decides what may be used, and this only reorders it.
    public var controlPlaneBase: String? {
        get { storage.string(Key.controlBase) }
        set { storage.setString(Key.controlBase, newValue) }
    }

    /// Signs the account out.
    ///
    /// Everything the account owns goes; the configs the person pasted in stay.
    /// Those were bought from somebody else, or handed over in a channel, and
    /// signing out of this app is not a reason to lose them — a person who had
    /// to re-paste forty configs to log back in would not log back in.
    public func clear() {
        let keepImported = importedConfigs
        storage.removeAll()
        importedConfigs = keepImported
    }
}
