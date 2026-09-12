import Foundation

/// What this phone has learned about each gateway, kept between sessions.
///
/// Everything the tunnel decides in the moment comes from measurements taken in
/// the moment — but a gateway that refused to connect three times yesterday is
/// a fact worth carrying, and one that has never once failed is worth
/// defending. This is that memory, and it is the only part of selection that is
/// not recomputed from scratch on every connect.
///
/// What is stored is deliberately thin: a `host:port`, counters, and timings.
/// No credential, no UUID, no profile line — nothing here would let anyone use
/// an account, and nothing here is ever logged.
public struct ServerStats: Equatable {
    /// Weight of the newest sample. Low enough that one outlier cannot swing it.
    static let alpha = 0.3

    public let key: String
    public var attempts: Int
    public var successes: Int
    /// Failures since the last success. Reset by a success, not by time.
    public var consecutiveFailures: Int
    /// Smoothed round trip in milliseconds, or nil when never measured.
    public var rttMs: Double?
    /// Smoothed movement of that round trip: how steady the path has been.
    public var jitterMs: Double?
    public var lastSuccessAt: Int64
    public var lastFailureAt: Int64
    /// When this entry was last touched, so the oldest can be dropped first.
    public var updatedAt: Int64

    public init(
        key: String,
        attempts: Int = 0,
        successes: Int = 0,
        consecutiveFailures: Int = 0,
        rttMs: Double? = nil,
        jitterMs: Double? = nil,
        lastSuccessAt: Int64 = 0,
        lastFailureAt: Int64 = 0,
        updatedAt: Int64 = 0
    ) {
        self.key = key
        self.attempts = attempts
        self.successes = successes
        self.consecutiveFailures = consecutiveFailures
        self.rttMs = rttMs
        self.jitterMs = jitterMs
        self.lastSuccessAt = lastSuccessAt
        self.lastFailureAt = lastFailureAt
        self.updatedAt = updatedAt
    }

    /// How often connecting has worked, smoothed so that one attempt does not
    /// read as certainty: a gateway with 1/1 is not proven better than one with
    /// 40/45. Consecutive failures then divide it, because a gateway failing
    /// *now* matters more than its record from a month ago.
    public var reliability: Double {
        ((Double(successes) + 1.0) / (Double(attempts) + 2.0)) / (1.0 + Double(consecutiveFailures))
    }

    /// A new round-trip sample, folded in.
    public func withSample(_ sampleMs: Int64, now: Int64) -> ServerStats {
        var next = self
        let sample = Double(sampleMs)
        let previous = rttMs
        next.rttMs = previous.map { $0 + Self.alpha * (sample - $0) } ?? sample
        if let previous {
            let movement = abs(sample - previous)
            next.jitterMs = jitterMs.map { $0 + Self.alpha * (movement - $0) } ?? movement
        }
        next.updatedAt = now
        return next
    }

    /// The outcome of an actual connection attempt.
    public func withOutcome(success: Bool, now: Int64) -> ServerStats {
        var next = self
        next.attempts = attempts + 1
        next.successes = success ? successes + 1 : successes
        next.consecutiveFailures = success ? 0 : consecutiveFailures + 1
        next.lastSuccessAt = success ? now : lastSuccessAt
        next.lastFailureAt = success ? lastFailureAt : now
        next.updatedAt = now
        return next
    }
}

/// The whole memory, a value: every change returns a new one, so the tunnel and
/// the screen cannot see it half-written.
public struct ConnectionMemory {
    /// Enough for far more gateways than a subscription offers.
    public static let limit = 64
    private static let version = "v1"

    public static let empty = ConnectionMemory(stats: [:])

    private let stats: [String: ServerStats]

    private init(stats: [String: ServerStats]) { self.stats = stats }

    public static func of(_ entries: [ServerStats]) -> ConnectionMemory {
        ConnectionMemory(stats: Dictionary(entries.map { ($0.key, $0) }) { _, last in last })
    }

    public var size: Int { stats.count }

    public func of(_ key: String) -> ServerStats? { stats[key] }

    public func recordSample(_ key: String, rttMs: Int64, now: Int64) -> ConnectionMemory {
        replace(key, (stats[key] ?? ServerStats(key: key)).withSample(rttMs, now: now))
    }

    public func recordOutcome(_ key: String, success: Bool, now: Int64) -> ConnectionMemory {
        replace(key, (stats[key] ?? ServerStats(key: key)).withOutcome(success: success, now: now))
    }

    /// Drops everything not in `keys` — a subscription that no longer offers a
    /// gateway should not keep a record of it for ever.
    public func keepOnly(_ keys: Set<String>) -> ConnectionMemory {
        ConnectionMemory(stats: stats.filter { keys.contains($0.key) })
    }

    private func replace(_ key: String, _ entry: ServerStats) -> ConnectionMemory {
        var next = stats
        next[key] = entry
        if next.count > Self.limit {
            // Bounded on purpose: this is written on every connect, and an
            // unbounded one would grow with every gateway ever offered.
            let oldest = next.values.sorted { $0.updatedAt < $1.updatedAt }
                .prefix(next.count - Self.limit)
            for entry in oldest { next.removeValue(forKey: entry.key) }
        }
        return ConnectionMemory(stats: next)
    }

    /// A compact text form, one gateway per line, with a version marker so an
    /// older file can be recognised rather than misread.
    public func encode() -> String {
        var out = Self.version + "\n"
        // Sorted so the same memory encodes to the same text: a dictionary's
        // order is not stable across runs, and a file that changes when nothing
        // changed is a file nobody can diff.
        for entry in stats.values.sorted(by: { $0.key < $1.key }) {
            out += [
                entry.key,
                String(entry.attempts),
                String(entry.successes),
                String(entry.consecutiveFailures),
                entry.rttMs.map(String.init) ?? "",
                entry.jitterMs.map(String.init) ?? "",
                String(entry.lastSuccessAt),
                String(entry.lastFailureAt),
                String(entry.updatedAt),
            ].joined(separator: "|") + "\n"
        }
        return out
    }

    /// Reads `encode`'s output back. Anything unreadable — a truncated write, a
    /// file from a future version — is no memory rather than a crash: the
    /// tunnel measures from scratch, which it can always do.
    public static func decode(_ text: String?) -> ConnectionMemory {
        guard let text else { return empty }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
            .filter { !$0.trimmed.isEmpty }
        guard lines.first == version else { return empty }
        var parsed: [ServerStats] = []
        for line in lines.dropFirst() {
            let parts = line.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
            guard parts.count == 9 else { continue }
            guard let attempts = Int(parts[1]), let successes = Int(parts[2]),
                  let consecutive = Int(parts[3]),
                  let lastSuccess = Int64(parts[6]), let lastFailure = Int64(parts[7]),
                  let updated = Int64(parts[8]) else { continue }
            // An empty field is "never measured"; a non-empty one that is not a
            // number is a damaged line, and a damaged line is dropped whole.
            if !parts[4].isEmpty && Double(parts[4]) == nil { continue }
            if !parts[5].isEmpty && Double(parts[5]) == nil { continue }
            parsed.append(ServerStats(
                key: parts[0],
                attempts: attempts,
                successes: successes,
                consecutiveFailures: consecutive,
                rttMs: parts[4].isEmpty ? nil : Double(parts[4]),
                jitterMs: parts[5].isEmpty ? nil : Double(parts[5]),
                lastSuccessAt: lastSuccess,
                lastFailureAt: lastFailure,
                updatedAt: updated
            ))
        }
        return of(parsed)
    }
}
