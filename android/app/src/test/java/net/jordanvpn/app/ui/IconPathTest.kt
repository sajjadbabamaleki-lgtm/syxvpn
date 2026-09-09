package net.jordanvpn.app.ui

import androidx.compose.ui.graphics.vector.PathParser
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the icon outlines against the mistake that shipped once.
 *
 * Compose reads SVG path data as a plain run of numbers: it does not know that
 * an arc's two flags are single digits. So `a9 9 0 11-12.8 0` — which every
 * browser draws correctly, and which is how these outlines were first written —
 * gives the parser 6 parameters where an arc needs 7. It does not fail; it drops
 * the arc, or lands it somewhere it was never meant to go. On a phone that
 * turned the power icon into a bare vertical line and the globe into a scribble,
 * and nothing said so until the app was on a screen.
 *
 * The invariant that catches it needs no expected pictures: every number written
 * in a path must end up as a parameter of a parsed node. When the compact form
 * eats one, the count comes up short.
 *
 * The source is read as text rather than the constants imported, so an icon
 * added later is covered without anyone remembering to add it here.
 */
class IconPathTest {

    private val literal = Regex("""ICON_[A-Z_]+\s*=\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+)""")
    private val stringPart = Regex(""""((?:[^"\\]|\\.)*)"""")
    private val number = Regex("""-?\d*\.?\d+(?:[eE][-+]?\d+)?""")

    @Test
    fun everyNumberInAnIconPathSurvivesParsing() {
        val source = File("src/main/java/net/jordanvpn/app/ui/Screens.kt")
        assertTrue("icon source not found at ${source.absolutePath}", source.exists())

        val icons = literal.findAll(source.readText()).toList()
        assertTrue("no icon paths found — has the naming changed?", icons.size >= 8)

        val broken = mutableListOf<String>()
        icons.forEach { match ->
            val name = match.value.substringBefore('=').trim()
            val data = stringPart.findAll(match.groupValues[1]).joinToString("") { it.groupValues[1] }
            val written = number.findAll(data).count()
            val nodes = PathParser().parsePathString(data).toNodes()
            val kept = nodes.sumOf { node ->
                node::class.java.methods.count { it.name.startsWith("component") }
            }
            if (nodes.isEmpty() || written != kept) {
                broken += "$name: $written numbers written, $kept parsed into ${nodes.size} nodes"
            }
        }
        assertTrue(
            "icon paths the parser could not read whole (write arc flags spaced: " +
                "\"a9 9 0 1 1 -12.8 0\"):\n" + broken.joinToString("\n"),
            broken.isEmpty(),
        )
    }
}
