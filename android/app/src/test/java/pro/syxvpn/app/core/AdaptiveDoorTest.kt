package pro.syxvpn.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * One gateway, several ways in, and what the engine does as they degrade.
 *
 * These are the continuity tests for the adaptive part: not whether a packet
 * arrives — nothing on a JVM can say that — but whether the decision that gets
 * made when a door stops working is the one that keeps somebody connected.
 * Every case here is a network that has gone wrong in a way these markets see:
 * one protocol throttled while another is untouched, a door that answers its
 * handshake and then carries nothing, a door that is briefly slower.
 *
 * The gateway is the same host throughout. That is the point — the fallback
 * being tested is a change of protocol, not a change of server.
 */
class AdaptiveDoorTest {

    private val host = "gw1.example.net"

    private fun vless(port: Int = 443) = VlessProfile(
        uri = "vless://uuid@$host:$port?type=ws",
        uuid = "uuid",
        host = host,
        port = port,
        label = "Edge A · de",
        tls = true,
        sni = null,
        wsPath = "/ws",
        wsHost = null,
    )

    private fun shadowsocks(port: Int = 8388) = ShadowsocksProfile(
        uri = "ss://x@$host:$port",
        host = host,
        port = port,
        label = "Edge A · de · shadowsocks",
        method = "2022-blake3-aes-256-gcm",
        password = "server:user",
    )

    private fun trojan(port: Int = 8443) = TrojanProfile(
        uri = "trojan://p@$host:$port",
        host = host,
        port = port,
        label = "Edge A · de · trojan",
        password = "p",
        sni = host,
        fingerprint = "chrome",
    )

    private fun door(profile: TunnelProfile) = Server(profile = profile, routeState = RouteState.HEALTHY)

    private val doors = listOf(door(vless()), door(shadowsocks()), door(trojan()))

    @Test
    fun `doors into one gateway are separate candidates`() {
        // They differ only by port, and the key is what everything else —
        // measurements, memory, the active server — is filed under. If two
        // doors collapsed into one key, every measurement of one would be
        // credited to the other.
        val keys = doors.map { it.key }
        assertEquals(keys.toSet().size, keys.size)
        assertNotEquals(doors[0].key, doors[1].key)
    }

    @Test
    fun `the door that stops answering loses to the one that still does`() {
        // The ordinary shape of a block: the protocol everybody uses is
        // throttled to nothing, the newer one is not touched yet.
        val probes = mapOf(
            doors[0].key to Probe(doors[0].key, rttMs = null, attempted = true),
            doors[1].key to Probe(doors[1].key, rttMs = 90, attempted = true),
        )
        val ranked = SmartConnect.rank(doors, probes = probes)
        assertEquals(doors[1].key, ranked.first().server.key)
        // And the dead one is still in the list: it is blocked on this network,
        // not gone, and the next network may be a different network.
        assertTrue(ranked.any { it.server.key == doors[0].key })
    }

    @Test
    fun `a door proven end to end beats a faster one that was never tried`() {
        // A handshake to the port proves the port. It does not prove the door
        // carries traffic, and a censor's tarpit answers handshakes all day.
        val ranked = SmartConnect.rank(
            doors,
            probes = mapOf(doors[0].key to Probe(doors[0].key, rttMs = 10, attempted = true)),
            endToEnd = mapOf(doors[1].key to 240L),
        )
        assertEquals(doors[1].key, ranked.first().server.key)
    }

    @Test
    fun `a door tested end to end and found dead goes behind the untested ones`() {
        val ranked = SmartConnect.rank(doors, endToEnd = mapOf(doors[0].key to null))
        assertEquals(doors[0].key, ranked.last().server.key)
    }

    @Test
    fun `failures accumulate against a door until another one wins`() {
        // Nothing here is a single bad moment: the tunnel came up on this door
        // and dropped, three times, and each time the memory wrote it down.
        var memory = ConnectionMemory.EMPTY
        var now = 1_000L
        repeat(3) {
            memory = memory.recordOutcome(doors[0].key, success = false, now = now)
            now += 60_000
        }
        memory = memory.recordOutcome(doors[1].key, success = true, now = now)

        val ranked = SmartConnect.rank(doors, memory = memory, purpose = Purpose.SOCIAL)
        assertEquals(doors[1].key, ranked.first().server.key)
    }

    @Test
    fun `a door that is briefly slower does not move a working tunnel`() {
        // Every switch costs every open connection. A door that is better by a
        // hair is not better, and a tunnel that chases the best score flaps
        // between two doors on the same box for as long as it is up.
        val memory = ConnectionMemory.EMPTY
            .recordSample(doors[0].key, 100, 1_000L)
            .recordSample(doors[1].key, 95, 1_000L)
        val ranked = SmartConnect.rank(doors, memory = memory)
        val connected = SmartConnect.connectOrder(
            servers = doors,
            memory = memory,
            current = doors[0].key,
        )
        assertEquals(
            "a tunnel that is up stays up unless the challenger is clearly better",
            doors[0].key,
            connected.first().key,
        )
        assertTrue(ranked.isNotEmpty())
    }

    @Test
    fun `a door that is clearly better does take the tunnel`() {
        // The other half of the same rule: when the door in use has actually
        // stopped working, hysteresis must not hold the tunnel on it.
        val order = SmartConnect.connectOrder(
            servers = doors,
            probes = mapOf(doors[0].key to Probe(doors[0].key, rttMs = null, attempted = true)),
            endToEnd = mapOf(doors[1].key to 60L),
            current = doors[0].key,
        )
        assertEquals(doors[1].key, order.first().key)
    }

    @Test
    fun `every door is offered exactly once, in a stable order`() {
        // The fallback walks this list. A door missing from it is a door the
        // tunnel will not try however bad things get, and a door in it twice is
        // a retry of something that just failed.
        val order = SmartConnect.connectOrder(servers = doors)
        assertEquals(doors.size, order.size)
        assertEquals(doors.map { it.key }.toSet(), order.map { it.key }.toSet())
        assertEquals(order.map { it.key }, SmartConnect.connectOrder(servers = doors).map { it.key })
    }

    @Test
    fun `what the purpose weighs applies to doors as much as to gateways`() {
        // Gaming cares about the round trip; Social cares about the door that
        // has never let it down. The two should not agree here.
        //
        // The round trip comes from this measurement, not from the memory: what
        // the memory holds about latency is how much it *moves*, which is the
        // stability term. A test that put the fast number only in the memory
        // would be asserting something the engine does not read.
        val probes = mapOf(
            doors[0].key to Probe(doors[0].key, rttMs = 20, attempted = true),
            doors[1].key to Probe(doors[1].key, rttMs = 140, attempted = true),
        )
        val memory = ConnectionMemory.EMPTY
            .recordOutcome(doors[0].key, success = false, now = 2_000L)
            .recordOutcome(doors[0].key, success = false, now = 3_000L)
            .recordOutcome(doors[1].key, success = true, now = 2_000L)
            .recordOutcome(doors[1].key, success = true, now = 3_000L)

        val gaming = SmartConnect.rank(doors, probes = probes, memory = memory, purpose = Purpose.GAMING)
        val social = SmartConnect.rank(doors, probes = probes, memory = memory, purpose = Purpose.SOCIAL)
        assertEquals(doors[0].key, gaming.first().server.key)
        assertEquals(doors[1].key, social.first().server.key)
    }
}
