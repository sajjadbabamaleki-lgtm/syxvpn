package net.jordanvpn.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The resolver is the app's answer to a network that will not resolve its
 * control plane, so what matters is that it reads a real answer correctly,
 * refuses the parts of one that are not addresses, tries the second operator
 * when the first says nothing, and does not ask again while an answer is good.
 */
class DohResolverTest {
    /** A provider's answer, built without nesting quotes inside quotes. */
    private fun answer(vararg addresses: String, ttl: Int = 300): String {
        val records = addresses.joinToString(",") { address ->
            "{\"name\":\"control.cvpn.pro\",\"type\":1,\"TTL\":$ttl,\"data\":\"$address\"}"
        }
        return "{\"Status\":0,\"Answer\":[$records]}"
    }

    @Test
    fun `reads the addresses out of an answer`() {
        val resolver = DohResolver(fetch = { answer("173.249.47.5") })
        assertEquals(listOf("173.249.47.5"), resolver.addresses("control.cvpn.pro"))
    }

    @Test
    fun `keeps only A records, because a CNAME's data is a name`() {
        val mixed = """
            {"Status":0,"Answer":[
              {"name":"control.cvpn.pro","type":5,"TTL":300,"data":"edge.example.net"},
              {"name":"edge.example.net","type":1,"TTL":300,"data":"173.249.47.5"}
            ]}
        """.trimIndent()
        val resolver = DohResolver(fetch = { mixed })
        assertEquals(listOf("173.249.47.5"), resolver.addresses("control.cvpn.pro"))
    }

    @Test
    fun `an answer with no addresses is not an answer`() {
        val resolver = DohResolver(fetch = { """{"Status":3,"Answer":[]}""" })
        assertTrue(resolver.addresses("control.cvpn.pro").isEmpty())
    }

    @Test
    fun `moves to the second operator when the first fails`() {
        val asked = mutableListOf<String>()
        val resolver = DohResolver(fetch = { url ->
            asked += url
            if (asked.size == 1) throw IllegalStateException("resolver answered 502")
            answer("10.1.2.3")
        })
        assertEquals(listOf("10.1.2.3"), resolver.addresses("control.cvpn.pro"))
        assertEquals(2, asked.size)
        assertTrue("the two endpoints are different operators", asked[0] != asked[1])
    }

    @Test
    fun `garbage from an endpoint is treated as silence, not as a crash`() {
        val resolver = DohResolver(fetch = { "<html>captive portal</html>" })
        assertTrue(resolver.addresses("control.cvpn.pro").isEmpty())
    }

    @Test
    fun `does not ask again while the answer is still good`() {
        var calls = 0
        val resolver = DohResolver(fetch = { calls++; answer("173.249.47.5") })
        resolver.addresses("control.cvpn.pro")
        resolver.addresses("control.cvpn.pro")
        assertEquals(1, calls)
    }

    @Test
    fun `asks again once the TTL has passed`() {
        var calls = 0
        var clock = 0L
        val resolver = DohResolver(
            fetch = { calls++; answer("173.249.47.5", ttl = 300) },
            now = { clock },
        )
        resolver.addresses("control.cvpn.pro")
        clock += 299_000
        resolver.addresses("control.cvpn.pro")
        assertEquals("still inside the TTL", 1, calls)
        clock += 2_000
        resolver.addresses("control.cvpn.pro")
        assertEquals(2, calls)
    }

    @Test
    fun `a one second TTL does not become a lookup per request`() {
        var calls = 0
        var clock = 0L
        val resolver = DohResolver(fetch = { calls++; answer("1.2.3.4", ttl = 1) }, now = { clock })
        resolver.addresses("control.cvpn.pro")
        clock += (DohResolver.MIN_TTL_SECONDS - 1) * 1000
        resolver.addresses("control.cvpn.pro")
        assertEquals(1, calls)
    }

    @Test
    fun `forgetting an address makes the next call ask`() {
        var calls = 0
        val resolver = DohResolver(fetch = { calls++; answer("1.2.3.4") })
        resolver.addresses("control.cvpn.pro")
        resolver.forget("control.cvpn.pro")
        resolver.addresses("control.cvpn.pro")
        assertEquals(2, calls)
    }

    @Test
    fun `the host being asked about is the host in the query`() {
        var asked: String? = null
        val resolver = DohResolver(fetch = { url -> asked = url; answer("1.2.3.4") })
        resolver.addresses("gw1.cvpn.pro")
        assertTrue("query carries the name: $asked", asked!!.endsWith("name=gw1.cvpn.pro"))
    }

    @Test
    fun `dotted quads become four bytes, and nothing else does`() {
        assertEquals(
            listOf(173, 249, 47, 5),
            DohResolver.ipv4Bytes("173.249.47.5")!!.map { it.toInt() and 0xff },
        )
        assertEquals(
            listOf(255, 0, 128, 1),
            DohResolver.ipv4Bytes("255.0.128.1")!!.map { it.toInt() and 0xff },
        )
        assertNull("an octet over 255 is not an address", DohResolver.ipv4Bytes("256.1.1.1"))
        assertNull("a name is not an address", DohResolver.ipv4Bytes("edge.example.net"))
        assertNull("v6 is not handled here", DohResolver.ipv4Bytes("2001:db8::1"))
        assertNull(DohResolver.ipv4Bytes(""))
    }

    @Test
    fun `the endpoints are reached by address, since names are what failed`() {
        val hostPart = Regex("^https://([^/]+)/")
        DohResolver.DEFAULT_ENDPOINTS.forEach { endpoint ->
            val host = hostPart.find(endpoint)?.groupValues?.get(1)
            assertTrue("$endpoint is addressed by name", DohResolver.ipv4Bytes(host.orEmpty()) != null)
        }
    }
}
