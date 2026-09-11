package pro.syxvpn.app.core

/**
 * How healthy the control plane believes a gateway's whole path is.
 *
 * This is not the phone's opinion. `healthy` means the control plane has seen
 * the gateway's ingress answer *and* its egress carry traffic; `degraded` means
 * one of those is struggling; `unverified` means the egress has never been
 * proven. The phone can only measure the first hop, so this is the only source
 * of knowledge about the half of the path the phone cannot see.
 */
enum class RouteState(val rank: Int) {
    HEALTHY(0),
    DEGRADED(1),
    UNVERIFIED(2),
    UNKNOWN(3),
    ;

    companion object {
        fun of(value: String?) = when (value?.lowercase()) {
            "healthy" -> HEALTHY
            "degraded" -> DEGRADED
            "unverified" -> UNVERIFIED
            else -> UNKNOWN
        }
    }
}

/** A gateway the subscription is currently offering, with what is known about it. */
data class Server(
    val profile: TunnelProfile,
    val routeState: RouteState = RouteState.UNKNOWN,
    val gatewayName: String? = null,
    val region: String? = null,
    /**
     * Pasted in by the person rather than issued by this control plane.
     *
     * It changes what may be said about it and what may be done to it: no
     * health is claimed for it beyond what this phone measured, and a refresh
     * never removes it, because nothing here issued it and nothing here can
     * take it back.
     */
    val imported: Boolean = false,
) {
    /** Stable identity of a server across refreshes. */
    val key: String get() = "${profile.host}:${profile.port}"

    val label: String get() = gatewayName ?: profile.label
}

/**
 * What the phone found out about a server, on top of what the control plane said.
 *
 * [rttMs] is a real TCP handshake to the gateway, or null when it was not
 * measured. [reachable] is false only when a measurement was actually attempted
 * and failed — "not measured" and "did not answer" are different things and are
 * never collapsed here.
 */
data class Probe(
    val key: String,
    val rttMs: Long? = null,
    val attempted: Boolean = false,
) {
    val reachable: Boolean get() = rttMs != null
    val failed: Boolean get() = attempted && rttMs == null
}

/**
 * Picks the server to connect through.
 *
 * The ordering mirrors the control plane's own egress selection, for the same
 * reason it exists there: a fast first hop tells you nothing about whether the
 * gateway can still reach the internet, so measured latency is a tie-breaker
 * *within* a health class, never a substitute for it.
 *
 *   1. a gateway that was measured and did not answer goes last, whatever the
 *      control plane thinks of it — the phone cannot use what it cannot reach
 *   2. then by route state: healthy, degraded, unverified, unknown
 *   3. then by measured latency; a gateway that was never measured sorts after
 *      measured ones in the same class, because an unknown number is not a good
 *      number
 *   4. then by the order the control plane returned them in, which is its own
 *      priority, and finally by key so the result is deterministic
 *
 * Switching servers costs every open connection, so [pick] keeps the current
 * one unless the alternative is better in a way a person would notice: a better
 * health class, or at least [MIN_IMPROVEMENT_MS] faster. Without that
 * hysteresis a pair of gateways a few milliseconds apart would swap places on
 * every refresh.
 */
object ServerPicker {

    /** Below this, a latency difference is noise, not an improvement. */
    const val MIN_IMPROVEMENT_MS = 40L

    fun rank(servers: List<Server>, probes: Map<String, Probe> = emptyMap()): List<Server> =
        servers.withIndex().sortedWith(
            compareBy(
                { (_, server) -> if (probes[server.key]?.failed == true) 1 else 0 },
                { (_, server) -> server.routeState.rank },
                { (_, server) -> if (probes[server.key]?.reachable == true) 0 else 1 },
                { (_, server) -> probes[server.key]?.rttMs ?: Long.MAX_VALUE },
                { (index, _) -> index },
                { (_, server) -> server.key },
            ),
        ).map { it.value }

    /**
     * @param current the server in use, if any. Returns it unchanged unless
     *   another one is materially better, or it is no longer offered or
     *   reachable.
     */
    fun pick(
        servers: List<Server>,
        probes: Map<String, Probe> = emptyMap(),
        current: String? = null,
    ): Server? {
        val ranked = rank(servers, probes)
        val best = ranked.firstOrNull() ?: return null
        val inUse = servers.firstOrNull { it.key == current } ?: return best

        // A server that stopped answering, or that the control plane no longer
        // calls usable, is not worth defending.
        if (probes[inUse.key]?.failed == true) return best
        if (best.routeState.rank < inUse.routeState.rank) return best
        if (best.routeState.rank > inUse.routeState.rank) return inUse

        val bestRtt = probes[best.key]?.rttMs ?: return inUse
        val currentRtt = probes[inUse.key]?.rttMs ?: return best
        return if (currentRtt - bestRtt >= MIN_IMPROVEMENT_MS) best else inUse
    }

    /**
     * The order to try when connecting: the pick first, then the rest as
     * fallbacks. Failover walks this list, so a gateway that failed its
     * measurement is still in it — last — rather than being thrown away: a
     * refused handshake on one port is not proof the server is gone.
     *
     * [endToEnd] is the stronger evidence, when there is any: a round trip made
     * *through* a gateway, in milliseconds, or null for one that was tried and
     * did not answer. A first-hop handshake says the gateway is reachable; only
     * this says the gateway can still reach the internet. So anything proven
     * end to end goes first, ordered by that number; servers nobody could test
     * follow in their ordinary rank; and a server that failed the end-to-end
     * test goes last, behind even the untested ones.
     */
    fun connectOrder(
        servers: List<Server>,
        probes: Map<String, Probe> = emptyMap(),
        endToEnd: Map<String, Long?> = emptyMap(),
        current: String? = null,
    ): List<Server> {
        val ranked = rank(servers, probes)
        if (endToEnd.isEmpty()) {
            val chosen = pick(servers, probes, current) ?: return emptyList()
            return listOf(chosen) + ranked.filterNot { it.key == chosen.key }
        }

        val proven = ranked.filter { endToEnd[it.key] != null }
            .sortedBy { endToEnd.getValue(it.key) }
        val untested = ranked.filterNot { endToEnd.containsKey(it.key) }
        val failed = ranked.filter { endToEnd.containsKey(it.key) && endToEnd[it.key] == null }

        val order = proven + untested + failed
        val head = order.firstOrNull() ?: return emptyList()

        // Same hysteresis as pick(), on the numbers that were actually measured
        // here: keep the server in use unless the alternative is materially
        // faster end to end.
        val currentServer = order.firstOrNull { it.key == current }
        val currentDelay = current?.let { endToEnd[it] }
        val headDelay = endToEnd[head.key]
        if (currentServer != null && currentDelay != null && headDelay != null &&
            currentDelay - headDelay < MIN_IMPROVEMENT_MS
        ) {
            return listOf(currentServer) + order.filterNot { it.key == currentServer.key }
        }
        return order
    }
}
