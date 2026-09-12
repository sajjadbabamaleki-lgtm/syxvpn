package pro.syxvpn.app.core

/**
 * What is known about whether traffic actually reaches the internet through a
 * gateway.
 *
 * The core starting is not that knowledge. `start` returning without throwing
 * means Xray accepted the configuration and opened its inbound — it says
 * nothing about the gateway on the other end answering, and a tunnel whose
 * far half is dead starts exactly as cleanly as one that works. The app used
 * to treat the two as the same thing and show CONNECTED over a path that had
 * never carried a byte, which is the most expensive kind of wrong: the switch
 * says it is on, the counters say zero, and nothing anywhere says why.
 *
 * So the decision is named and kept apart from the service that acts on it.
 */
enum class PathEvidence {
    /** A real request went through and came back. */
    WORKS,

    /** A real request was made and did not come back. */
    FAILS,

    /** No request was made. Nothing is claimed either way. */
    UNKNOWN,
    ;

    /**
     * Whether a gateway with this evidence may be connected to.
     *
     * [UNKNOWN] passes. Absence of a measurement is not a failure, and refusing
     * to connect without one would strand every phone whose probe the network
     * happens to be blocking that minute.
     */
    val usable: Boolean get() = this != FAILS

    companion object {
        /**
         * Reads one gateway's end-to-end measurement.
         *
         * The probe reports a round-trip in milliseconds, or null for no
         * answer; a key that was never probed is absent from the map entirely.
         * Those are three different things and the caller needs all three, so
         * they do not collapse into a boolean here.
         */
        fun of(endToEnd: Map<String, Long?>, key: String): PathEvidence = when {
            !endToEnd.containsKey(key) -> UNKNOWN
            endToEnd[key] != null -> WORKS
            else -> FAILS
        }
    }
}
