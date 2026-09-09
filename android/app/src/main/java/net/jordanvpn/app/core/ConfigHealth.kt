package net.jordanvpn.app.core

/**
 * How an imported config is doing — and nothing more than that.
 *
 * The Configs tab is manual. This measures, it colours a dot, it shows a number
 * that was actually measured; it never selects, replaces, reorders or edits a
 * config, and no code path leads from a health result to a connection decision.
 * That separation is the point of having two tabs at all.
 *
 * What is measured is a TCP handshake to the config's own host and port. The
 * app's own sockets are kept out of the tunnel it runs (`addDisallowedApplication`
 * in the service), so this number means the same thing whether the tunnel is up
 * or down: how far away the first hop is from this phone, right now. It says
 * nothing about whether that server can still reach the internet — the tunnel
 * finds that out end to end, and the Configs tab does not pretend to know it.
 */
enum class ConfigHealth {
    /** Answered, promptly and steadily. */
    GOOD,

    /** Answered, but slowly, or unevenly, or not every time. */
    UNSTABLE,

    /** Tried and did not answer. */
    OFFLINE,

    /** Never measured on this phone. Not a verdict — an absence of one. */
    UNKNOWN,
    ;

    companion object {

        /** Past this, a first hop is slow enough to notice. */
        const val SLOW_MS = 600.0

        /** Past this, the round trip moves enough to be felt as stalling. */
        const val UNSTEADY_JITTER_MS = 120.0

        /** Older than this, a measurement is history rather than a state. */
        const val STALE_AFTER_MS = 15 * 60 * 1000L

        /**
         * @param probe the most recent measurement, if one was taken this session.
         * @param stats what this phone remembers about the same server.
         * @param now used only to decide whether the memory is too old to speak for.
         */
        fun of(probe: Probe?, stats: ServerStats?, now: Long): ConfigHealth {
            if (probe?.failed == true) return OFFLINE
            val rtt = probe?.rttMs?.toDouble() ?: stats?.rttMs?.takeIf {
                stats.updatedAt > 0 && now - stats.updatedAt <= STALE_AFTER_MS
            } ?: return UNKNOWN

            val unsteady = (stats?.jitterMs ?: 0.0) > UNSTEADY_JITTER_MS
            val flaky = (stats?.consecutiveFailures ?: 0) > 0
            return if (rtt > SLOW_MS || unsteady || flaky) UNSTABLE else GOOD
        }
    }
}
