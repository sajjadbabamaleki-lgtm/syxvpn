package pro.syxvpn.app.core

/**
 * How hard the tunnel tries to come back on its own.
 *
 * A tunnel that drops should reconnect without anyone touching the phone. A
 * tunnel that cannot connect must not spend the battery finding that out over
 * and over — and it must not hide the failure behind an endless "connecting…"
 * either. So recovery is bounded on both axes: a growing delay between
 * attempts, and a ceiling on how many attempts a window may hold.
 *
 * Time is passed in rather than read, so this is testable and has no clock of
 * its own.
 */
class RecoveryPolicy(
    /** Attempts allowed inside [windowMs] before the tunnel gives up and says so. */
    private val maxAttempts: Int = MAX_ATTEMPTS,
    private val windowMs: Long = WINDOW_MS,
    private val delaysMs: List<Long> = DELAYS_MS,
) {
    private val attempts = ArrayDeque<Long>()

    /** Attempts still counted at [now]. */
    fun recentAttempts(now: Long): Int {
        while (attempts.isNotEmpty() && now - attempts.first() > windowMs) attempts.removeFirst()
        return attempts.size
    }

    fun canRetry(now: Long): Boolean = recentAttempts(now) < maxAttempts

    /**
     * Records an attempt and returns how long to wait before making it. The
     * first recovery is immediate; each further one in the same window waits
     * longer, so a gateway that is simply down is not hammered.
     */
    fun nextDelayMs(now: Long): Long {
        val index = recentAttempts(now).coerceAtMost(delaysMs.lastIndex)
        attempts.addLast(now)
        return delaysMs[index]
    }

    /**
     * Called when a session has stayed up long enough to count as recovered.
     * The window starts again, so a phone that moves between networks all day
     * is not eventually refused a reconnection.
     */
    fun settled() = attempts.clear()

    companion object {
        const val MAX_ATTEMPTS = 4
        const val WINDOW_MS = 10 * 60 * 1000L

        /** Immediate, then backing off. Past the end, the last one repeats. */
        val DELAYS_MS = listOf(0L, 2_000L, 8_000L, 20_000L)

        /** A session that lasts this long has recovered, not merely started. */
        const val SETTLED_AFTER_MS = 60_000L
    }
}
