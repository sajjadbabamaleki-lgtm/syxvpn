package pro.syxvpn.app.core

/**
 * Which gateway the tunnel connects through, and in what order it falls back.
 *
 * The rule this engine is built on has not changed: **evidence outranks
 * scoring**. A round trip made *through* a gateway proves the far half of the
 * path; a handshake to it proves only the first hop; a score is an opinion
 * about numbers. So candidates are put in three tiers first, and the score only
 * decides the order *within* a tier:
 *
 *   1. proven end to end — a request came back through this gateway
 *   2. untested — nothing was measured through it, one way or the other
 *   3. failed — it was tried and did not answer, at either hop
 *
 * Inside a tier the score is [Purpose]'s weights applied to four signals:
 * the control plane's view of the gateway, the round trip, how steady that
 * round trip has been on this phone, and how often connecting has worked.
 *
 * It is deterministic and it is arithmetic — no model, no network call, nothing
 * that can be slow at the moment someone presses ON. The signals are the
 * extension point: a richer one (packet loss, per-gateway load, a second
 * transport) enters as another term, and the tiers and the shape stay.
 *
 * This is the VPN side only. Configs are chosen by the person who imported
 * them, and nothing here is applied to that list.
 */
object SmartConnect {

    /**
     * A challenger must beat the connected gateway by this much before the
     * tunnel moves. Every switch costs every open connection, so a score that
     * is barely better is not better.
     */
    const val MIN_SCORE_GAIN = 0.05

    /** The round trip at which the latency term is worth half. */
    private const val LATENCY_REFERENCE_MS = 150.0

    /** The jitter at which the stability term is worth half. */
    private const val JITTER_REFERENCE_MS = 40.0

    /** A number nobody measured is not a good number, and not a disqualifying one. */
    private const val UNMEASURED_LATENCY = 0.35
    private const val UNMEASURED_STABILITY = 0.5

    /** One candidate, and why it sits where it does. */
    data class Scored(
        val server: Server,
        val score: Double,
        val tier: Int,
        val rttMs: Long?,
    )

    /**
     * The score for one gateway, between 0 and 1.
     *
     * @param endToEnd milliseconds measured through this gateway, null when it
     *   was tried and failed, absent when it was never tried.
     */
    fun score(
        server: Server,
        probe: Probe? = null,
        endToEnd: Long? = null,
        stats: ServerStats? = null,
        weights: Weights = Purpose.AUTO.weights,
    ): Double {
        val health = when (server.routeState) {
            RouteState.HEALTHY -> 1.0
            RouteState.DEGRADED -> 0.5
            // "Never proven" is worse than "not reported": the control plane is
            // saying something about this gateway, and it is not good news.
            RouteState.UNVERIFIED -> 0.3
            RouteState.UNKNOWN -> 0.45
        }

        // End to end when there is one, because it covers the whole path.
        val rtt = endToEnd ?: probe?.rttMs
        val latency = if (rtt == null) UNMEASURED_LATENCY else 1.0 / (1.0 + rtt / LATENCY_REFERENCE_MS)

        val jitter = stats?.jitterMs
        val stability = if (jitter == null) UNMEASURED_STABILITY else 1.0 / (1.0 + jitter / JITTER_REFERENCE_MS)

        val reliability = stats?.reliability ?: 0.5

        return weights.health * health +
            weights.latency * latency +
            weights.stability * stability +
            weights.reliability * reliability
    }

    /**
     * Every candidate, scored and tiered, best first.
     *
     * Ties break on the order the control plane returned them in — that order is
     * its own priority — and then on the key, so the same inputs always give the
     * same list.
     */
    fun rank(
        servers: List<Server>,
        probes: Map<String, Probe> = emptyMap(),
        endToEnd: Map<String, Long?> = emptyMap(),
        memory: ConnectionMemory = ConnectionMemory.EMPTY,
        purpose: Purpose = Purpose.AUTO,
    ): List<Scored> = servers.withIndex().map { (index, server) ->
        val probe = probes[server.key]
        val measured = endToEnd[server.key]
        val tested = endToEnd.containsKey(server.key)
        val tier = when {
            tested && measured == null -> 2
            probe?.failed == true -> 2
            tested -> 0
            else -> 1
        }
        Triple(
            index,
            tier,
            Scored(
                server = server,
                score = score(server, probe, measured, memory.of(server.key), purpose.weights),
                tier = tier,
                rttMs = measured ?: probe?.rttMs,
            ),
        )
    }.sortedWith(
        compareBy(
            { it.second },
            { -it.third.score },
            { it.first },
            { it.third.server.key },
        ),
    ).map { it.third }

    /**
     * The order to try when connecting: the pick first, then the fallbacks.
     *
     * A gateway that failed its measurement stays in the list, last, rather than
     * being thrown away — a refused handshake on one port is not proof the
     * gateway is gone, and a list of one is not a fallback list.
     *
     * @param current the gateway in use, kept at the head unless a challenger
     *   beats it by [MIN_SCORE_GAIN] or it has dropped into a worse tier.
     */
    fun connectOrder(
        servers: List<Server>,
        probes: Map<String, Probe> = emptyMap(),
        endToEnd: Map<String, Long?> = emptyMap(),
        memory: ConnectionMemory = ConnectionMemory.EMPTY,
        purpose: Purpose = Purpose.AUTO,
        current: String? = null,
    ): List<Server> {
        val ranked = rank(servers, probes, endToEnd, memory, purpose)
        val head = ranked.firstOrNull() ?: return emptyList()
        val inUse = ranked.firstOrNull { it.server.key == current }

        val keep = inUse != null &&
            inUse.tier <= head.tier &&
            head.score - inUse.score < MIN_SCORE_GAIN

        val order = if (keep) {
            listOf(inUse!!) + ranked.filterNot { it.server.key == inUse.server.key }
        } else {
            ranked
        }
        return order.map { it.server }
    }

    /** The one to connect through, which is the head of [connectOrder]. */
    fun pick(
        servers: List<Server>,
        probes: Map<String, Probe> = emptyMap(),
        endToEnd: Map<String, Long?> = emptyMap(),
        memory: ConnectionMemory = ConnectionMemory.EMPTY,
        purpose: Purpose = Purpose.AUTO,
        current: String? = null,
    ): Server? = connectOrder(servers, probes, endToEnd, memory, purpose, current).firstOrNull()
}
