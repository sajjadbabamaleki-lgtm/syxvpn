package pro.sixvpn.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The parsers that decide what the tunnel connects to.
 *
 * A profile that parses wrong is a tunnel to somewhere else, or no tunnel at
 * all, so every one of these is about a line that exists in the wild rather
 * than a line this control plane happens to write.
 */
class TunnelProfileTest {

    private val ss2022 = "ss://" +
        "MjAyMi1ibGFrZTMtYWVzLTI1Ni1nY206c2VydmVyS2V5OnVzZXJLZXk" +
        "@203.0.113.4:8388#Edge%20A%20%C2%B7%20de"

    @Test
    fun `a SIP002 line carries the method and the whole password`() {
        val profile = ShadowsocksProfile.parse(ss2022)!!
        assertEquals("203.0.113.4", profile.host)
        assertEquals(8388, profile.port)
        assertEquals("2022-blake3-aes-256-gcm", profile.method)
        // Both halves of a 2022 key, and the colon between them belongs to the
        // password. Splitting on the last colon instead of the first would hand
        // the core half a key and a method it has never heard of.
        assertEquals("serverKey:userKey", profile.password)
        assertEquals("Edge A · de", profile.label)
    }

    @Test
    fun `the older all-in-one encoding is read too`() {
        // ss://base64(method:password@host:port) — what a lot of panels still
        // hand out, and what half the channels paste.
        val blob = base64("aes-256-gcm:hunter2@203.0.113.9:8388")
        val profile = ShadowsocksProfile.parse("ss://$blob#Old")!!
        assertEquals("203.0.113.9", profile.host)
        assertEquals(8388, profile.port)
        assertEquals("aes-256-gcm", profile.method)
        assertEquals("hunter2", profile.password)
        assertEquals("Old", profile.label)
    }

    @Test
    fun `a plain-text credential is accepted, because issuers write them`() {
        val profile = ShadowsocksProfile.parse("ss://aes-256-gcm:hunter2@h.example.net:8388")!!
        assertEquals("aes-256-gcm", profile.method)
        assertEquals("hunter2", profile.password)
        assertEquals("h.example.net:8388", profile.label)
    }

    @Test
    fun `a shadowsocks line that is missing something is refused, not guessed at`() {
        assertNull(ShadowsocksProfile.parse("ss://"))
        assertNull(ShadowsocksProfile.parse("ss://@h.example.net:8388"))
        assertNull(ShadowsocksProfile.parse("ss://${base64("aes-256-gcm:pw")}@h.example.net"))
        assertNull(ShadowsocksProfile.parse("ss://${base64("aes-256-gcm:pw")}@h.example.net:0"))
        assertNull(ShadowsocksProfile.parse("ss://${base64("nocolonhere")}@h.example.net:8388"))
        assertNull(ShadowsocksProfile.parse("vless://x@h:443"))
    }

    @Test
    fun `a trojan line is TLS, and says which name to claim`() {
        val profile = TrojanProfile.parse(
            "trojan://s3cret@203.0.113.4:8443?security=tls&sni=edge.example.net&fp=chrome#Edge",
        )!!
        assertEquals("s3cret", profile.password)
        assertEquals(8443, profile.port)
        assertEquals("edge.example.net", profile.sni)
        assertEquals("chrome", profile.fingerprint)
        assertEquals("Edge", profile.label)
    }

    @Test
    fun `a trojan line with no security parameter is still TLS`() {
        // The parameter is newer than the protocol, and trojan has never been
        // anything but TLS. Refusing these would refuse most of them.
        val profile = TrojanProfile.parse("trojan://s3cret@203.0.113.4:8443")!!
        assertEquals("203.0.113.4", profile.sni)
        assertNull(profile.fingerprint)
    }

    @Test
    fun `a trojan line that claims not to be TLS is refused`() {
        // The disguise is a web server behind a certificate. Without TLS there
        // is nothing to hide behind, and the connection cannot work at all —
        // better said here than on the phone, at the moment somebody needs it.
        assertNull(TrojanProfile.parse("trojan://s3cret@203.0.113.4:8443?security=none"))
    }

    @Test
    fun `a trojan line with no password is refused`() {
        assertNull(TrojanProfile.parse("trojan://@203.0.113.4:8443"))
    }

    @Test
    fun `the one door in routes every scheme to its own parser`() {
        assertTrue(TunnelProfile.parse(ss2022) is ShadowsocksProfile)
        assertTrue(TunnelProfile.parse("trojan://p@h.example.net:443") is TrojanProfile)
        assertTrue(
            TunnelProfile.parse("vless://11111111-2222-3333-4444-555555555555@h.example.net:443?type=ws")
                is VlessProfile,
        )
        assertNull(TunnelProfile.parse("vmess://eyJ2IjoiMiJ9"))
        assertNull(TunnelProfile.parse("https://example.net"))
    }

    @Test
    fun `whitespace around a pasted line is not part of it`() {
        assertNotNull(TunnelProfile.parse("  $ss2022  "))
    }

    @Test
    fun `each kind says what it is, in the words the screen shows`() {
        assertEquals("shadowsocks · 2022-blake3-aes-256-gcm", ShadowsocksProfile.parse(ss2022)!!.protocolLabel)
        assertEquals("trojan · tls", TrojanProfile.parse("trojan://p@h.example.net:443")!!.protocolLabel)
        assertEquals(
            "vless · ws · tls",
            VlessProfile.parse("vless://11111111-2222-3333-4444-555555555555@h:443?type=ws&security=tls")!!
                .protocolLabel,
        )
    }

    private fun base64(text: String): String {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        val bytes = text.toByteArray(Charsets.UTF_8)
        return buildString {
            var index = 0
            while (index < bytes.size) {
                val b0 = bytes[index].toInt() and 0xFF
                val b1 = if (index + 1 < bytes.size) bytes[index + 1].toInt() and 0xFF else 0
                val b2 = if (index + 2 < bytes.size) bytes[index + 2].toInt() and 0xFF else 0
                append(alphabet[b0 shr 2])
                append(alphabet[((b0 and 0x03) shl 4) or (b1 shr 4)])
                if (index + 1 < bytes.size) append(alphabet[((b1 and 0x0F) shl 2) or (b2 shr 6)])
                if (index + 2 < bytes.size) append(alphabet[b2 and 0x3F])
                index += 3
            }
        }
    }
}
