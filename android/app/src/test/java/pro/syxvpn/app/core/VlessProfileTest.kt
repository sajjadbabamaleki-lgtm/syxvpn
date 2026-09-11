package pro.syxvpn.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The most security-relevant parser in the app, and until now the only proof it
 * worked was that it seemed to.
 *
 * It could not be tested where it stood: it was built on android.net.Uri, which
 * is a stub on a JVM runner and returns nulls for everything. A profile that
 * parses wrong is a tunnel to somewhere else, or no tunnel at all — the two
 * failures worth a test more than any other.
 *
 * The literals here are what `server/src/domain/xray.js` really emits. If the
 * two sides drift, this is where it should hurt.
 */
class VlessProfileTest {

    @Test
    fun `reads a websocket profile as the control plane writes it`() {
        val profile = VlessProfile.parse(
            "vless://11111111-2222-3333-4444-555555555555@edge.example.net:443" +
                "?encryption=none&type=ws&path=%2Fws&host=edge.example.net" +
                "&security=tls&sni=edge.example.net&fp=chrome#Edge%20A%20%C2%B7%20tehran",
        )!!
        assertEquals("11111111-2222-3333-4444-555555555555", profile.uuid)
        assertEquals("edge.example.net", profile.host)
        assertEquals(443, profile.port)
        assertTrue(profile.tls)
        assertEquals("edge.example.net", profile.sni)
        assertEquals("/ws", profile.wsPath)
        assertEquals("edge.example.net", profile.wsHost)
        assertEquals("Edge A · tehran", profile.label)
        assertNull(profile.reality)
    }

    @Test
    fun `reads a REALITY profile as the control plane writes it`() {
        val profile = VlessProfile.parse(
            "vless://11111111-2222-3333-4444-555555555555@203.0.113.9:443" +
                "?encryption=none&security=reality&type=tcp&flow=xtls-rprx-vision" +
                "&sni=www.microsoft.com&fp=chrome" +
                "&pbk=uNm292XHIOI0wHLfn5fiOOquk47pn6kjiYhqwermDjA&sid=a1b2c3d4#Edge%20R",
        )!!
        val reality = profile.reality!!
        assertEquals("uNm292XHIOI0wHLfn5fiOOquk47pn6kjiYhqwermDjA", reality.publicKey)
        assertEquals("a1b2c3d4", reality.shortId)
        assertEquals("xtls-rprx-vision", reality.flow)
        assertEquals("chrome", reality.fingerprint)
        // The name claimed in the handshake is the borrowed site's, and the
        // socket still goes to the gateway's own address.
        assertEquals("www.microsoft.com", reality.serverName)
        assertEquals("203.0.113.9", profile.host)
        assertTrue(profile.tls)
    }

    @Test
    fun `a REALITY profile with no public key is refused, not half-built`() {
        // There would be nothing to encrypt to. Connecting anyway means being
        // forwarded to the borrowed site and told, at length, that the tunnel
        // is fine.
        val without = "vless://uuid@203.0.113.9:443?security=reality&type=tcp&sid=a1b2c3d4"
        assertNull(VlessProfile.parse(without))
        assertNull(VlessProfile.parse("$without&pbk="))
    }

    @Test
    fun `REALITY over anything but tcp is refused`() {
        assertNull(
            VlessProfile.parse("vless://uuid@h:443?security=reality&type=ws&pbk=abc"),
        )
    }

    @Test
    fun `a short ID may be absent, which means the gateway takes any subscriber`() {
        val profile = VlessProfile.parse(
            "vless://uuid@203.0.113.9:443?security=reality&type=tcp&pbk=abc&sni=example.org",
        )!!
        assertEquals("", profile.reality!!.shortId)
    }

    @Test
    fun `defaults match what a profile leaves out`() {
        val profile = VlessProfile.parse("vless://uuid@edge.example.net:8443?security=none")!!
        assertEquals("/ws", profile.wsPath)
        assertNull(profile.wsHost)
        assertNull(profile.sni)
        assertEquals(false, profile.tls)
        // No fragment: the address is the only name there is.
        assertEquals("edge.example.net", profile.label)
    }

    @Test
    fun `a label survives being a label`() {
        // Real ones carry spaces, middots and Persian, and are often not
        // encoded at all — which is exactly what java_net_URI refuses.
        val raw = VlessProfile.parse("vless://uuid@h:443#Frankfurt · سریع")!!
        assertEquals("Frankfurt · سریع", raw.label)

        val encoded = VlessProfile.parse(
            "vless://uuid@h:443#%D8%A2%D9%84%D9%85%D8%A7%D9%86",
        )!!
        // Multi-byte UTF-8 decoded as a whole rather than escape by escape,
        // which is where mojibake comes from.
        assertEquals("آلمان", encoded.label)

        val question = VlessProfile.parse("vless://uuid@h:443?type=ws#Berlin · fast?")!!
        assertEquals("Berlin · fast?", question.label)
        assertEquals("/ws", question.wsPath)
    }

    @Test
    fun `a plus is a plus, not a space`() {
        // '+' for space belongs to HTML form encoding. A WebSocket path of
        // "/ws+1" is a real path, and turning it into "/ws 1" is a 404.
        val profile = VlessProfile.parse("vless://uuid@h:443?type=ws&path=%2Fws%2B1")!!
        assertEquals("/ws+1", profile.wsPath)
        assertEquals("/ws+1", VlessProfile.parse("vless://uuid@h:443?type=ws&path=/ws+1")!!.wsPath)
    }

    @Test
    fun `an IPv6 gateway keeps its address and its port apart`() {
        val profile = VlessProfile.parse("vless://uuid@[2001:db8::1]:8443?type=ws")!!
        assertEquals("2001:db8::1", profile.host)
        assertEquals(8443, profile.port)
    }

    @Test
    fun `a bare IPv6 address without brackets is refused rather than guessed at`() {
        assertNull(VlessProfile.parse("vless://uuid@2001:db8::1:8443?type=ws"))
    }

    @Test
    fun `a profile with no port is refused`() {
        // Xray would have to invent one, and the gateway is not on 443 because
        // somebody hoped so.
        assertNull(VlessProfile.parse("vless://uuid@edge.example.net?type=ws"))
        assertNull(VlessProfile.parse("vless://uuid@edge.example.net:0?type=ws"))
        assertNull(VlessProfile.parse("vless://uuid@edge.example.net:99999?type=ws"))
        assertNull(VlessProfile.parse("vless://uuid@edge.example.net:https?type=ws"))
    }

    @Test
    fun `a profile with no credential is refused`() {
        assertNull(VlessProfile.parse("vless://edge.example.net:443?type=ws"))
        assertNull(VlessProfile.parse("vless://@edge.example.net:443?type=ws"))
    }

    @Test
    fun `another scheme is not a vless profile`() {
        for (other in listOf(
            "vmess://uuid@h:443",
            "trojan://p@h:443",
            "https://example.com",
            "vless:/uuid@h:443",
            "",
            "vless://",
        )) {
            assertNull(other, VlessProfile.parse(other))
        }
    }

    @Test
    fun `a transport this app cannot open is refused rather than misconfigured`() {
        for (type in listOf("grpc", "http", "quic", "kcp", "xhttp")) {
            assertNull(type, VlessProfile.parse("vless://uuid@h:443?type=$type"))
        }
    }

    @Test
    fun `the original line is kept so it can be copied out again`() {
        val line = "vless://uuid@h:443?type=ws&path=%2Fws#Edge"
        assertEquals(line, VlessProfile.parse(line)!!.uri)
    }

    @Test
    fun `a repeated parameter takes the first, as every other client does`() {
        val profile = VlessProfile.parse("vless://uuid@h:443?type=ws&path=/first&path=/second")!!
        assertEquals("/first", profile.wsPath)
    }

    @Test
    fun `an emoji in a label survives, escaped or not`() {
        // A flag is a surrogate pair per letter. Re-encoding characters that
        // were never escaped turns each half into a question mark, and half of
        // every flag in a server list is damage nobody traces to a URI parser.
        val plain = VlessProfile.parse("vless://uuid@h:443#\uD83C\uDDE9\uD83C\uDDEA Frankfurt")!!
        assertEquals("\uD83C\uDDE9\uD83C\uDDEA Frankfurt", plain.label)

        val escaped = VlessProfile.parse(
            "vless://uuid@h:443#%F0%9F%87%A9%F0%9F%87%AA%20Frankfurt",
        )!!
        assertEquals("\uD83C\uDDE9\uD83C\uDDEA Frankfurt", escaped.label)
        assertEquals(plain.label, escaped.label)
    }

    @Test
    fun `a stray percent is a percent, not a swallowed character`() {
        assertEquals("100% up", UriParts.percentDecode("100% up"))
        assertEquals("%zz", UriParts.percentDecode("%zz"))
        assertEquals("ends with %", UriParts.percentDecode("ends with %"))
    }
}
