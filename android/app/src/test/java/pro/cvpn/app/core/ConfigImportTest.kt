package pro.cvpn.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What a person actually has in their clipboard.
 *
 * Every shape here is one somebody really pastes, and the cost of rejecting any
 * of them is the same: a person holding the right thing being told it is wrong,
 * with no way to find out which part of it was the problem.
 */
class ConfigImportTest {

    private val one = "vless://11111111-2222-3333-4444-555555555555@a.example.net:443?type=ws&path=%2Fws#Server A"
    private val two = "vless://22222222-2222-3333-4444-555555555555@b.example.net:8443?type=ws#Server B"
    private val reality = "vless://33333333-2222-3333-4444-555555555555@203.0.113.9:443" +
        "?security=reality&type=tcp&flow=xtls-rprx-vision&sni=www.microsoft.com&fp=chrome" +
        "&pbk=uNm292XHIOI0wHLfn5fiOOquk47pn6kjiYhqwermDjA&sid=a1b2c3d4#Reality"

    private fun base64(text: String): String {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        val bytes = text.toByteArray(Charsets.UTF_8)
        val out = StringBuilder()
        var i = 0
        while (i < bytes.size) {
            val b0 = bytes[i].toInt() and 0xFF
            val b1 = if (i + 1 < bytes.size) bytes[i + 1].toInt() and 0xFF else 0
            val b2 = if (i + 2 < bytes.size) bytes[i + 2].toInt() and 0xFF else 0
            out.append(alphabet[b0 shr 2])
            out.append(alphabet[((b0 and 0x03) shl 4) or (b1 shr 4)])
            out.append(if (i + 1 < bytes.size) alphabet[((b1 and 0x0F) shl 2) or (b2 shr 6)] else '=')
            out.append(if (i + 2 < bytes.size) alphabet[b2 and 0x3F] else '=')
            i += 3
        }
        return out.toString()
    }

    @Test
    fun `one pasted config`() {
        val result = ConfigImport.parse(one)
        assertEquals(1, result.added.size)
        assertEquals("a.example.net", result.added[0].host)
        assertEquals(0, result.rejected)
    }

    @Test
    fun `a whole list at once, in the order it was pasted`() {
        val result = ConfigImport.parse("$one\n$two\n$reality")
        assertEquals(listOf("a.example.net", "b.example.net", "203.0.113.9"), result.added.map { it.host })
    }

    @Test
    fun `blank lines, stray spaces and windows line endings`() {
        // Copied out of a chat app, which is where these actually come from.
        val messy = "\r\n  $one  \r\n\r\n\t$two\r\n   \r\n"
        assertEquals(2, ConfigImport.parse(messy).added.size)
    }

    @Test
    fun `the base64 blob a subscription URL answers with`() {
        // People paste the *answer* as often as they paste the link.
        val result = ConfigImport.parse(base64("$one\n$two"))
        assertEquals(2, result.added.size)
        assertEquals("a.example.net", result.added[0].host)
    }

    @Test
    fun `base64 that is url-safe, or unpadded, or wrapped across lines`() {
        val padded = base64("$one\n$two")
        val urlSafe = padded.replace('+', '-').replace('/', '_')
        val unpadded = padded.trimEnd('=')
        val wrapped = padded.chunked(64).joinToString("\n")
        // Subscription endpoints disagree about all three, and a person pasting
        // one has no idea which they were handed.
        for (variant in listOf(padded, urlSafe, unpadded, wrapped)) {
            assertEquals(variant.take(12), 2, ConfigImport.parse(variant).added.size)
        }
    }

    @Test
    fun `comment lines are skipped, but a label after a hash is not a comment`() {
        val withComments = "# my servers\n$one\n// from the channel\n$two"
        val result = ConfigImport.parse(withComments)
        assertEquals(2, result.added.size)
        // "#Server A" is the config's own name and lives inside the line.
        assertEquals("Server A", result.added[0].label)
        assertEquals(0, result.rejected)
    }

    @Test
    fun `pasting the same list twice does not double it`() {
        // What happens when somebody re-copies a whole channel post to get the
        // one new server in it.
        val first = ConfigImport.parse("$one\n$two")
        val again = ConfigImport.parse("$one\n$two\n$reality", first.added.map { it.uri })
        assertEquals(1, again.added.size)
        assertEquals(2, again.duplicates)
        assertEquals("203.0.113.9", again.added[0].host)
    }

    @Test
    fun `a duplicate inside one paste counts once`() {
        val result = ConfigImport.parse("$one\n$one\n$two")
        assertEquals(2, result.added.size)
        assertEquals(1, result.duplicates)
    }

    @Test
    fun `what cannot be read is counted, not silently dropped`() {
        val result = ConfigImport.parse("$one\nvless://broken\nnot a config at all\n$two")
        assertEquals(2, result.added.size)
        assertEquals(2, result.rejected)
        assertTrue(result.summary().contains("could not be read"))
    }

    @Test
    fun `other protocols are refused rather than half-accepted`() {
        // The app runs Xray with a VLESS outbound. Taking a vmess line and
        // failing at connect time is worse than saying so now.
        val result = ConfigImport.parse(
            "vmess://eyJ2IjoiMiJ9\ntrojan://password@h.example.net:443\nss://YWVzOnB3@h:8388",
        )
        assertTrue(result.isEmpty)
        assertEquals(3, result.rejected)
    }

    @Test
    fun `nothing at all is not an error, it is nothing`() {
        for (empty in listOf("", "   ", "\n\n", "# just a comment")) {
            val result = ConfigImport.parse(empty)
            assertTrue(empty, result.isEmpty)
            assertEquals(empty, 0, result.rejected)
            assertEquals("Nothing to add", result.summary())
        }
    }

    @Test
    fun `the summary says what happened in the person's terms`() {
        assertEquals("Added 1 config", ConfigImport.parse(one).summary())
        assertEquals("Added 2 configs", ConfigImport.parse("$one\n$two").summary())
        assertEquals("You already have that one", ConfigImport.parse(one, listOf(one)).summary())
        assertEquals("You already have all 2", ConfigImport.parse("$one\n$two", listOf(one, two)).summary())
        assertEquals("That does not look like a config", ConfigImport.parse("nonsense").summary())
        assertEquals(
            "Added 1 config, 1 already here, 1 could not be read",
            ConfigImport.parse("$one\n$two\nrubbish", listOf(one)).summary(),
        )
    }

    @Test
    fun `a REALITY config from somebody else works like any other`() {
        // Nothing here is specific to configs this control plane issued.
        val result = ConfigImport.parse(reality)
        assertEquals(1, result.added.size)
        assertEquals("uNm292XHIOI0wHLfn5fiOOquk47pn6kjiYhqwermDjA", result.added[0].reality!!.publicKey)
    }

    @Test
    fun `a long paste is read once, not unwrapped forever`() {
        // base64 of base64 is not a format anybody produces, and chasing it
        // would be a way to hang on a large paste.
        val doubled = base64(base64("$one\n$two"))
        assertTrue(ConfigImport.parse(doubled).isEmpty)
    }
}
