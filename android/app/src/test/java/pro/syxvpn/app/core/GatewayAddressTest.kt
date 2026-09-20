package pro.syxvpn.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The gateway behind a CDN is addressed by name, and the core cannot resolve
 * names: Go does not read Android's DNS configuration, and the resolver
 * libXray is pointed at instead is blocked where this app is used. So the
 * phone resolves, and what is dialled is an address.
 */
class GatewayAddressTest {
    @Test
    fun `an address is left alone`() {
        assertEquals("76.13.78.219", GatewayAddress.of("76.13.78.219"))
        assertTrue(GatewayAddress.isLiteral("76.13.78.219"))
        assertTrue(GatewayAddress.isLiteral("2606:4700::1111"))
    }

    @Test
    fun `a name is a name`() {
        assertFalse(GatewayAddress.isLiteral("api.xoft.pro"))
        assertFalse(GatewayAddress.isLiteral("edge7.gamotion.pro"))
        // Not every dotted string is an address, and a label of digits is a
        // perfectly legal hostname.
        assertFalse(GatewayAddress.isLiteral("1.example.net"))
    }

    @Test
    fun `an unresolvable name comes back as itself`() {
        // Nothing here throws: a caller that cannot resolve still gets a config
        // it can hand to the core, which may manage where this could not.
        val name = "gateway.invalid"
        assertEquals(name, GatewayAddress.of(name, DohResolver(fetch = { error("no network") })))
    }
}
