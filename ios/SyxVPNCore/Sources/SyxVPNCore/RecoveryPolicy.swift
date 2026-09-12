import Foundation

/// How hard the tunnel tries to come back on its own.
///
/// A tunnel that drops should reconnect without anyone touching the phone. A
/// tunnel that cannot connect must not spend the battery finding that out over
/// and over — and it must not hide the failure behind an endless "connecting…"
/// either. So recovery is bounded on both axes: a growing delay between
/// attempts, and a ceiling on how many attempts a window may hold.
///
/// Time is passed in rather than read, so this is testable and has no clock of
/// its own.
public final class RecoveryPolicy {
    public static let maxAttemptsDefault = 4
    public static let windowMsDefault: Int64 = 10 * 60 * 1000

    /// Immediate, then backing off. Past the end, the last one repeats.
    public static let delaysMsDefault: [Int64] = [0, 2_000, 8_000, 20_000]

    /// A session that lasts this long has recovered, not merely started.
    public static let settledAfterMs: Int64 = 60_000

    /// Attempts allowed inside `windowMs` before the tunnel gives up and says so.
    private let maxAttempts: Int
    private let windowMs: Int64
    private let delaysMs: [Int64]
    private var attempts: [Int64] = []

    public init(
        maxAttempts: Int = RecoveryPolicy.maxAttemptsDefault,
        windowMs: Int64 = RecoveryPolicy.windowMsDefault,
        delaysMs: [Int64] = RecoveryPolicy.delaysMsDefault
    ) {
        self.maxAttempts = maxAttempts
        self.windowMs = windowMs
        self.delaysMs = delaysMs
    }

    /// Attempts still counted at `now`.
    @discardableResult
    public func recentAttempts(now: Int64) -> Int {
        while let first = attempts.first, now - first > windowMs { attempts.removeFirst() }
        return attempts.count
    }

    public func canRetry(now: Int64) -> Bool { recentAttempts(now: now) < maxAttempts }

    /// Records an attempt and returns how long to wait before making it. The
    /// first recovery is immediate; each further one in the same window waits
    /// longer, so a gateway that is simply down is not hammered.
    public func nextDelayMs(now: Int64) -> Int64 {
        let index = min(recentAttempts(now: now), delaysMs.count - 1)
        attempts.append(now)
        return delaysMs[index]
    }

    /// Called when a session has stayed up long enough to count as recovered.
    /// The window starts again, so a phone that moves between networks all day
    /// is not eventually refused a reconnection.
    public func settled() { attempts.removeAll() }
}
