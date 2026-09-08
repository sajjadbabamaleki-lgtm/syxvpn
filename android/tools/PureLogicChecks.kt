package net.jordanvpn.app.tools

import net.jordanvpn.app.core.supportLink
import net.jordanvpn.app.ui.formatBytes
import net.jordanvpn.app.ui.formatRemaining
import net.jordanvpn.app.ui.formatUsdt
import net.jordanvpn.app.ui.parseIsoMillis

/**
 * Checks for the parts of the app that need no Android SDK.
 *
 * The rest of the app cannot be compiled without the SDK, but money formatting
 * and contact parsing are ordinary Kotlin and are exactly the places where a
 * quiet mistake would be expensive — a wrong amount does not settle an order.
 * Run them with nothing but a Kotlin compiler:
 *
 *     kotlinc android/app/src/main/java/net/jordanvpn/app/core/SupportContact.kt \
 *             android/app/src/main/java/net/jordanvpn/app/ui/Format.kt \
 *             android/tools/PureLogicChecks.kt -include-runtime -d /tmp/checks.jar
 *     java -jar /tmp/checks.jar
 */
private var failures = 0

private fun check(what: String, actual: Any?, expected: Any?) {
    if (actual != expected) {
        failures++
        println("FAIL $what: expected <$expected>, got <$actual>")
    } else {
        println("ok   $what = $actual")
    }
}

fun main() {
    // Money. The amount is the order's identifier on chain, so it has to come
    // out of the integer exactly as the API sent it.
    check("formatUsdt(1_000_000)", formatUsdt(1_000_000), "1")
    check("formatUsdt(3_500_000)", formatUsdt(3_500_000), "3.5")
    check("formatUsdt(500_000)", formatUsdt(500_000), "0.5")
    check("formatUsdt(12_345_678)", formatUsdt(12_345_678), "12.345678")
    check("formatUsdt(1_000_001)", formatUsdt(1_000_001), "1.000001")
    check("formatUsdt(4_990_000)", formatUsdt(4_990_000), "4.99")
    check("formatUsdt(0)", formatUsdt(0), "0")

    check("formatBytes(0)", formatBytes(0), "0 B")
    check("formatBytes(1023)", formatBytes(1023), "1023 B")
    check("formatBytes(50 GB)", formatBytes(50L * 1024 * 1024 * 1024), "50 GB")

    val at = parseIsoMillis("2026-09-08T16:00:00.000Z")
    check("parseIsoMillis", at, 1788883200000L) // 2026-09-08T16:00:00Z
    check("parseIsoMillis(garbage)", parseIsoMillis("later"), null)
    check("formatRemaining(+42min)", formatRemaining("2026-09-08T16:00:00.000Z", at!! - 42 * 60000), "in 42 min")
    check("formatRemaining(+2h5)", formatRemaining("2026-09-08T16:00:00.000Z", at - 125 * 60000), "in 2 h 5 min")
    check("formatRemaining(past)", formatRemaining("2026-09-08T16:00:00.000Z", at + 1000), "expired")

    check("supportLink(handle)", supportLink("@jordanhelp"), "https://t.me/jordanhelp")
    check("supportLink(t.me)", supportLink("t.me/jordanhelp"), "https://t.me/jordanhelp")
    check("supportLink(https)", supportLink("https://help.example.net"), "https://help.example.net")
    check("supportLink(email)", supportLink("help@example.net"), "mailto:help@example.net")
    check("supportLink(prose)", supportLink("call us on the phone"), null)
    check("supportLink(empty)", supportLink("   "), null)

    println(if (failures == 0) "all checks passed" else "$failures check(s) failed")
    if (failures > 0) kotlin.system.exitProcess(1)
}
