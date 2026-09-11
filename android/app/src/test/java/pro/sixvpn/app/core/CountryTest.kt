package pro.sixvpn.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Where a gateway is, worked out from what a subscription actually carries.
 *
 * The JSON form has a region field. The plain base64 form — every subscription
 * not issued by this control plane, and this one when the JSON call fails —
 * carries nothing but the label, so the label is where the country has to come
 * from on exactly the clients least able to ask again.
 */
class CountryTest {

    private fun serverWith(label: String, region: String? = null) = Server(
        profile = VlessProfile.parse(
            "vless://11111111-2222-3333-4444-555555555555@h.example.net:443?type=ws#" +
                label.replace(" ", "%20"),
        )!!,
        region = region,
    )

    @Test
    fun `the region field wins when there is one`() {
        assertEquals("DE", countryOf(serverWith("Anything at all", region = "de-fra"))?.code)
    }

    @Test
    fun `a label ending in a region is read`() {
        assertEquals("NL", countryOf(serverWith("Amsterdam Edge · nl-ams"))?.code)
    }

    @Test
    fun `a protocol at the end of the label does not hide the country`() {
        // The label of a second door is `name · region · kind`. Reading only
        // the last segment filed every one of those under "other servers".
        assertEquals("DE", countryOf(serverWith("Frankfurt Edge · de-fra · shadowsocks"))?.code)
        assertEquals("FI", countryOf(serverWith("Helsinki Edge · fi · trojan"))?.code)
        assertEquals("SE", countryOf(serverWith("Stockholm · se · reality"))?.code)
    }

    @Test
    fun `a label with no region in it is not forced into a country`() {
        // "Other servers" is a real answer. Inventing a country for a gateway
        // whose label does not say one would put it on a map it never claimed.
        assertNull(countryOf(serverWith("Some Server · fastest · premium")))
        assertNull(countryOf(serverWith("My own config")))
    }
}
