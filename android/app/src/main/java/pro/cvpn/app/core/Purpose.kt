package pro.cvpn.app.core

/**
 * What the person is using the tunnel for, and what that changes.
 *
 * This is not a filter over the server list and it is not decoration: a purpose
 * is a set of weights, and the weights are what [SmartConnect] scores servers
 * with. Two purposes will genuinely pick different gateways out of the same
 * list — Gaming takes the lowest round trip even from a gateway that failed
 * once this week, Social takes the gateway that has never failed even when it
 * is 60 ms further away.
 *
 * It applies to the VPN side only. A config the person imported is theirs, and
 * nothing here ever reorders, replaces or re-picks it.
 *
 * Adding a purpose is adding an entry: nothing else in the engine knows the
 * names, only the weights.
 */
enum class Purpose(val label: String, val weights: Weights) {

    /** No stated preference: every signal counts, none dominates. */
    AUTO("Auto", Weights(health = 0.35, latency = 0.25, stability = 0.20, reliability = 0.20)),

    /**
     * Messaging and social apps. These are small, frequent requests where a
     * connection that works every time beats one that is quick when it works,
     * so a gateway's own record carries the most weight.
     */
    SOCIAL("Social", Weights(health = 0.30, latency = 0.20, stability = 0.15, reliability = 0.35)),

    /**
     * Video. A stream fills a buffer and then lives off it, so 40 ms more on
     * the round trip is invisible while a gateway that stalls is not: steadiness
     * outranks speed here.
     */
    STREAMING("Streaming", Weights(health = 0.25, latency = 0.15, stability = 0.35, reliability = 0.25)),

    /**
     * Games. The round trip *is* the experience, and a jittery path is worse
     * than a slower steady one, so those two take most of the weight.
     */
    GAMING("Gaming", Weights(health = 0.15, latency = 0.45, stability = 0.30, reliability = 0.10)),
    ;

    companion object {
        fun of(value: String?): Purpose =
            entries.firstOrNull { it.name.equals(value, ignoreCase = true) } ?: AUTO
    }
}

/**
 * How much each signal counts, per purpose. The four are meant to sum to 1, so
 * a score is comparable between purposes; `PurposeTest` holds them to it.
 *
 * @param health what the control plane says about the gateway's whole path —
 *   the only signal that covers the half of the path the phone cannot see.
 * @param latency the round trip, end to end where it was measured through the
 *   gateway, otherwise the first hop.
 * @param stability how much that round trip moves about, from this phone's own
 *   history with the gateway.
 * @param reliability how often connecting to it has actually worked.
 */
data class Weights(
    val health: Double,
    val latency: Double,
    val stability: Double,
    val reliability: Double,
) {
    val sum: Double get() = health + latency + stability + reliability
}
