package pro.syxvpn.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * What matters here is the order the app tries addresses in, that a working one
 * is remembered across launches, and that a subscription link issued by an
 * address which has since gone dark is still usable.
 */
class ControlPlaneEndpointsTest {
    private var stored: String? = null

    private fun endpoints(vararg hosts: String) = ControlPlaneEndpoints(
        configured = hosts.toList(),
        remembered = { stored },
        remember = { stored = it },
    )

    @Test
    fun `configured order is the starting order`() {
        val e = endpoints("https://a.example", "https://b.example")
        assertEquals(listOf("https://a.example", "https://b.example"), e.ordered())
        assertEquals("https://a.example", e.current())
    }

    @Test
    fun `trailing slashes are removed so paths do not double up`() {
        val e = endpoints("https://a.example/", "https://b.example")
        assertEquals("https://a.example", e.current())
    }

    @Test
    fun `blanks and duplicates are dropped, order kept`() {
        val e = endpoints("https://a.example", "", "  ", "https://a.example/", "https://b.example")
        assertEquals(listOf("https://a.example", "https://b.example"), e.ordered())
    }

    @Test
    fun `a list with nothing in it is a build mistake, not a runtime state`() {
        assertThrows(IllegalArgumentException::class.java) { endpoints("", "   ") }
    }

    @Test
    fun `the one that worked is tried first next time`() {
        val e = endpoints("https://a.example", "https://b.example", "https://c.example")
        e.worked("https://b.example")
        assertEquals(
            listOf("https://b.example", "https://a.example", "https://c.example"),
            e.ordered(),
        )
    }

    @Test
    fun `a remembered address that is no longer in the build is ignored`() {
        stored = "https://retired.example"
        val e = endpoints("https://a.example", "https://b.example")
        assertEquals(listOf("https://a.example", "https://b.example"), e.ordered())
    }

    @Test
    fun `failing the remembered address forgets it`() {
        val e = endpoints("https://a.example", "https://b.example")
        e.worked("https://b.example")
        e.failed("https://b.example")
        assertNull(stored)
        assertEquals("https://a.example", e.current())
    }

    @Test
    fun `failing an address that was not the remembered one changes nothing`() {
        val e = endpoints("https://a.example", "https://b.example")
        e.worked("https://b.example")
        e.failed("https://a.example")
        assertEquals("https://b.example", stored)
    }

    @Test
    fun `an address that fails is not struck off the list`() {
        val e = endpoints("https://a.example", "https://b.example")
        e.failed("https://a.example")
        assertEquals("a blocked address today is a working one tomorrow", 2, e.ordered().size)
    }

    @Test
    fun `a subscription link moves to the address that answers`() {
        val e = endpoints("https://a.example", "https://b.example")
        assertEquals(
            "https://b.example/sub/tok3n",
            e.rebase("https://a.example/sub/tok3n", "https://b.example"),
        )
    }

    @Test
    fun `a link to somewhere else is left alone`() {
        val e = endpoints("https://a.example", "https://b.example")
        val foreign = "https://someone-elses-panel.example/sub/tok3n"
        assertEquals(foreign, e.rebase(foreign, "https://b.example"))
    }

    @Test
    fun `rebasing keeps the query the subscription was asked with`() {
        val e = endpoints("https://a.example", "https://b.example")
        assertEquals(
            "https://b.example/sub/tok3n?format=json",
            e.rebase("https://a.example/sub/tok3n?format=json", "https://b.example"),
        )
    }

    @Test
    fun `a host that only prefixes another is not mistaken for it`() {
        val e = endpoints("https://a.example", "https://a.example.net")
        assertEquals(
            "the longer host must not be rewritten as the shorter one plus a path",
            "https://a.example.net/sub/x",
            e.rebase("https://a.example.net/sub/x", "https://a.example.net"),
        )
    }
}
