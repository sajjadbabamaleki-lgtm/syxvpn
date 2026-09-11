package pro.sixvpn.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivateDnsTest {

    @Test
    fun `a phone that has never been asked gets the default`() {
        assertEquals(PrivateDns.DEFAULT, PrivateDns.of(null))
        assertEquals(PrivateDns.DEFAULT, PrivateDns.of(""))
    }

    @Test
    fun `a stored name this build does not know reads as the default, not as nothing`() {
        // A mode dropped in a later version must not leave a phone with a
        // resolver it cannot name — and must not silently fall back to the
        // plain one either, which would downgrade someone without telling them.
        assertEquals(PrivateDns.DEFAULT, PrivateDns.of("HANDCRAFTED_ARTISANAL_DNS"))
        assertTrue(PrivateDns.of("HANDCRAFTED_ARTISANAL_DNS").encrypted)
    }

    @Test
    fun `names round-trip through storage, whatever their case`() {
        PrivateDns.entries.forEach { mode ->
            assertEquals(mode, PrivateDns.of(mode.name))
            assertEquals(mode, PrivateDns.of(mode.name.lowercase()))
        }
    }

    @Test
    fun `standard is the configuration that shipped before this existed`() {
        // The rollback path. If this list changes, a build with the feature
        // flag off stops being the build people are already running.
        assertEquals(listOf("1.1.1.1", "8.8.8.8"), PrivateDns.STANDARD.addresses)
        assertFalse(PrivateDns.STANDARD.encrypted)
    }

    @Test
    fun `every encrypted endpoint is addressed by IP`() {
        // A resolver reached by name needs a resolver to reach it, and that
        // first query is the one nobody is encrypting. Anything with letters in
        // the host here is a name, and a name here is a leak.
        PrivateDns.entries.filter { it.encrypted }.forEach { mode ->
            val host = mode.dohUrl!!.removePrefix("https://").substringBefore('/')
            assertTrue(
                "${mode.name} resolves its own resolver by name: $host",
                host.all { it.isDigit() || it == '.' },
            )
            assertTrue("${mode.name} advertises no address", mode.addresses.isNotEmpty())
        }
    }

    @Test
    fun `only one mode leaves queries in clear text`() {
        assertEquals(listOf(PrivateDns.STANDARD), PrivateDns.entries.filterNot { it.encrypted })
    }
}
