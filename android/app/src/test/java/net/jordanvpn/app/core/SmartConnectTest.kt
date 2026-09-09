package net.jordanvpn.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The selection engine, checked on the behaviour that is actually promised.
 *
 * These are not shape tests. Each one states something a person would notice:
 * that Gaming and Social genuinely disagree about the same two gateways, that a
 * gateway proven end to end wins over a better-looking one that was never
 * tested, that the tunnel does not hop between gateways that are the same
 * within noise.
 */
class SmartConnectTest {

    private fun profile(host: String, port: Int = 443) = VlessProfile(
        uri = "vless://uuid@$host:$port",
        uuid = "uuid",
        host = host,
        port = port,
        label = host,
        tls = true,
        sni = null,
        wsPath = "/ws",
        wsHost = null,
    )

    private fun server(host: String, state: RouteState = RouteState.HEALTHY) =
        Server(profile = profile(host), routeState = state)

    @Test
    fun everyPurposeWeighsTheSameTotal() {
        Purpose.entries.forEach { purpose ->
            assertEquals(
                "${purpose.name} weights must sum to 1",
                1.0,
                purpose.weights.sum,
                1e-9,
            )
        }
    }

    @Test
    fun gamingTakesTheFastGatewayAndSocialTakesTheDependableOne() {
        // One gateway is quick and even, but has refused twice since it last
        // worked; the other is 90 ms further away and has never failed once.
        // A game feels the 90 ms; a messaging app feels the refusals.
        val quick = server("quick.example.net")
        val steady = server("steady.example.net")
        val now = 1_000_000L
        val memory = ConnectionMemory.of(
            listOf(
                ServerStats(
                    key = quick.key,
                    attempts = 10,
                    successes = 6,
                    consecutiveFailures = 2,
                    rttMs = 40.0,
                    jitterMs = 10.0,
                    updatedAt = now,
                ),
                ServerStats(
                    key = steady.key,
                    attempts = 30,
                    successes = 30,
                    consecutiveFailures = 0,
                    rttMs = 130.0,
                    jitterMs = 8.0,
                    updatedAt = now,
                ),
            ),
        )
        val probes = mapOf(
            quick.key to Probe(quick.key, rttMs = 40, attempted = true),
            steady.key to Probe(steady.key, rttMs = 130, attempted = true),
        )
        val servers = listOf(quick, steady)

        val forGaming = SmartConnect.pick(servers, probes, memory = memory, purpose = Purpose.GAMING)
        val forSocial = SmartConnect.pick(servers, probes, memory = memory, purpose = Purpose.SOCIAL)

        assertEquals(quick.key, forGaming?.key)
        assertEquals(steady.key, forSocial?.key)
        assertNotEquals(forGaming?.key, forSocial?.key)
    }

    @Test
    fun gamingWillNotTakeAFastGatewayThatCannotHoldStill() {
        // 40 ms that swings by 90 is worse to play on than a steady 130, and the
        // weights have to say so or "Gaming" is just a label for "lowest ping".
        val jittery = server("jittery.example.net")
        val steady = server("steady.example.net")
        val now = 1_000_000L
        val memory = ConnectionMemory.of(
            listOf(
                ServerStats(jittery.key, attempts = 20, successes = 20, rttMs = 40.0, jitterMs = 90.0, updatedAt = now),
                ServerStats(steady.key, attempts = 20, successes = 20, rttMs = 130.0, jitterMs = 8.0, updatedAt = now),
            ),
        )
        val probes = mapOf(
            jittery.key to Probe(jittery.key, rttMs = 40, attempted = true),
            steady.key to Probe(steady.key, rttMs = 130, attempted = true),
        )
        val pick = SmartConnect.pick(listOf(jittery, steady), probes, memory = memory, purpose = Purpose.GAMING)
        assertEquals(steady.key, pick?.key)
    }

    @Test
    fun provenEndToEndOutranksAnUntestedGatewayWithABetterScore() {
        // The untested one looks better on every signal the phone can see.
        val untested = server("fast.example.net")
        val proven = server("slow.example.net", RouteState.DEGRADED)
        val probes = mapOf(
            untested.key to Probe(untested.key, rttMs = 20, attempted = true),
            proven.key to Probe(proven.key, rttMs = 300, attempted = true),
        )
        val order = SmartConnect.connectOrder(
            servers = listOf(untested, proven),
            probes = probes,
            endToEnd = mapOf(proven.key to 400L),
        )
        assertEquals(proven.key, order.first().key)
    }

    @Test
    fun aGatewayThatFailedItsTestGoesLastButStaysInTheList() {
        val ok = server("ok.example.net")
        val dead = server("dead.example.net")
        val order = SmartConnect.connectOrder(
            servers = listOf(dead, ok),
            probes = mapOf(dead.key to Probe(dead.key, rttMs = null, attempted = true)),
            endToEnd = mapOf(dead.key to null),
        )
        assertEquals(listOf(ok.key, dead.key), order.map { it.key })
    }

    @Test
    fun theConnectedGatewayIsKeptWhenTheChallengerIsBarelyBetter() {
        val current = server("current.example.net")
        val challenger = server("other.example.net")
        val probes = mapOf(
            current.key to Probe(current.key, rttMs = 100, attempted = true),
            challenger.key to Probe(challenger.key, rttMs = 95, attempted = true),
        )
        val order = SmartConnect.connectOrder(
            servers = listOf(challenger, current),
            probes = probes,
            current = current.key,
        )
        assertEquals(current.key, order.first().key)
    }

    @Test
    fun theConnectedGatewayIsLeftWhenTheChallengerIsClearlyBetter() {
        val current = server("current.example.net", RouteState.DEGRADED)
        val challenger = server("other.example.net", RouteState.HEALTHY)
        val probes = mapOf(
            current.key to Probe(current.key, rttMs = 400, attempted = true),
            challenger.key to Probe(challenger.key, rttMs = 30, attempted = true),
        )
        val order = SmartConnect.connectOrder(
            servers = listOf(current, challenger),
            probes = probes,
            current = current.key,
        )
        assertEquals(challenger.key, order.first().key)
    }

    @Test
    fun theSameInputAlwaysGivesTheSameOrder() {
        val servers = (1..6).map { server("gw$it.example.net") }
        val first = SmartConnect.connectOrder(servers).map { it.key }
        val again = SmartConnect.connectOrder(servers.reversed()).map { it.key }
        // Reversing the input may change the order — the control plane's order is
        // a tie-break — but the same input must not.
        assertEquals(first, SmartConnect.connectOrder(servers).map { it.key })
        assertEquals(again, SmartConnect.connectOrder(servers.reversed()).map { it.key })
    }

    @Test
    fun everyServerIsOfferedExactlyOnce() {
        val servers = (1..5).map { server("gw$it.example.net") }
        val order = SmartConnect.connectOrder(
            servers = servers,
            probes = mapOf(servers[0].key to Probe(servers[0].key, null, attempted = true)),
            endToEnd = mapOf(servers[1].key to 120L, servers[2].key to null),
            current = servers[4].key,
        )
        assertEquals(servers.size, order.size)
        assertEquals(servers.map { it.key }.toSet(), order.map { it.key }.toSet())
    }
}
