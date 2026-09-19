package pro.syxvpn.app.data

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.IOException

/**
 * The two roads to the control plane: the phone's own, and the tunnel's.
 *
 * What is being protected here is the cost of a filtered network. The second
 * road only ever matters when the first one is cut, and if every request paid
 * the first one's timeout before taking it, the app would be unusable in the
 * one situation this exists for.
 */
class EitherTransportTest {
    private class Road(var open: Boolean, val name: String) : Transport {
        var calls = 0
        override fun exchange(
            method: String,
            url: String,
            headers: Map<String, String>,
            body: String?,
        ): HttpReply {
            calls++
            if (!open) throw IOException("$name is cut")
            return HttpReply(200, name)
        }
    }

    @Test
    fun `the ordinary road is used while it works`() {
        val direct = Road(open = true, name = "direct")
        val tunnel = Road(open = true, name = "tunnel")
        val transport = EitherTransport(direct, tunnel)

        assertEquals("direct", transport.exchange("GET", "https://control/x", emptyMap(), null).body)
        assertEquals(0, tunnel.calls)
    }

    @Test
    fun `a cut road falls through to the other one`() {
        val direct = Road(open = false, name = "direct")
        val tunnel = Road(open = true, name = "tunnel")
        val transport = EitherTransport(direct, tunnel)

        assertEquals("tunnel", transport.exchange("GET", "https://control/x", emptyMap(), null).body)
    }

    @Test
    fun `the road that worked is tried first, so the cut one is paid for once`() {
        val direct = Road(open = false, name = "direct")
        val tunnel = Road(open = true, name = "tunnel")
        val transport = EitherTransport(direct, tunnel)

        repeat(3) { transport.exchange("GET", "https://control/x", emptyMap(), null) }

        // One attempt, not three: the timeout on a filtered name is the whole
        // cost this is here to avoid.
        assertEquals(1, direct.calls)
        assertEquals(3, tunnel.calls)
    }

    @Test
    fun `the preference lapses, so a network that recovers is noticed`() {
        val direct = Road(open = false, name = "direct")
        val tunnel = Road(open = true, name = "tunnel")
        var clock = 0L
        val transport = EitherTransport(direct, tunnel, stickyMs = 1_000) { clock }

        transport.exchange("GET", "https://control/x", emptyMap(), null)
        direct.open = true
        clock = 1_001

        assertEquals("direct", transport.exchange("GET", "https://control/x", emptyMap(), null).body)
    }

    @Test
    fun `when the preferred road goes dark the other one takes over again`() {
        val direct = Road(open = false, name = "direct")
        val tunnel = Road(open = true, name = "tunnel")
        val transport = EitherTransport(direct, tunnel)

        transport.exchange("GET", "https://control/x", emptyMap(), null)
        // The tunnel is what goes down now — it is a tunnel — and the phone's
        // own road is back.
        tunnel.open = false
        direct.open = true

        assertEquals("direct", transport.exchange("GET", "https://control/x", emptyMap(), null).body)
        // And the next request starts there rather than on the dead tunnel.
        assertEquals("direct", transport.exchange("GET", "https://control/x", emptyMap(), null).body)
    }

    @Test(expected = IOException::class)
    fun `both roads cut reports a failure`() {
        val transport = EitherTransport(Road(open = false, "direct"), Road(open = false, "tunnel"))
        transport.exchange("GET", "https://control/x", emptyMap(), null)
    }
}
