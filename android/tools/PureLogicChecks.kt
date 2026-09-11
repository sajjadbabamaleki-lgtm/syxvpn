package pro.sixvpn.app.tools

import pro.sixvpn.app.core.CountryGroup
import pro.sixvpn.app.core.countryOf
import pro.sixvpn.app.core.countryOfRegion
import pro.sixvpn.app.core.flagEmoji
import pro.sixvpn.app.core.groupByCountry
import pro.sixvpn.app.core.Probe
import pro.sixvpn.app.core.RouteState
import pro.sixvpn.app.core.Server
import pro.sixvpn.app.core.ServerPicker
import pro.sixvpn.app.core.VlessProfile
import pro.sixvpn.app.core.supportLink
import pro.sixvpn.app.ui.formatBytes
import pro.sixvpn.app.ui.formatDaysLeft
import pro.sixvpn.app.ui.formatRemaining
import pro.sixvpn.app.ui.formatUsdt
import pro.sixvpn.app.ui.parseIsoMillis

/**
 * Checks for the parts of the app that need no Android SDK.
 *
 * The rest of the app cannot be compiled without the SDK, but money formatting
 * and contact parsing are ordinary Kotlin and are exactly the places where a
 * quiet mistake would be expensive — a wrong amount does not settle an order.
 * Run them with nothing but a Kotlin compiler:
 *
 *     kotlinc android/app/src/main/java/pro/sixvpn/app/core/SupportContact.kt \
 *             android/app/src/main/java/pro/sixvpn/app/ui/Format.kt \
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

    val day = 86_400_000L
    check("formatDaysLeft(22d)", formatDaysLeft("2026-09-08T16:00:00.000Z", at - 22 * day), "22 days left")
    check("formatDaysLeft(1d)", formatDaysLeft("2026-09-08T16:00:00.000Z", at - day), "1 day left")
    check("formatDaysLeft(hours)", formatDaysLeft("2026-09-08T16:00:00.000Z", at - 3600_000), "last day")
    check("formatDaysLeft(past)", formatDaysLeft("2026-09-08T16:00:00.000Z", at + 1000), "expired")
    check("formatDaysLeft(garbage)", formatDaysLeft("soon"), null)

    check("supportLink(handle)", supportLink("@sixvpnhelp"), "https://t.me/sixvpnhelp")
    check("supportLink(t.me)", supportLink("t.me/sixvpnhelp"), "https://t.me/sixvpnhelp")
    check("supportLink(https)", supportLink("https://help.example.net"), "https://help.example.net")
    check("supportLink(email)", supportLink("help@example.net"), "mailto:help@example.net")
    check("supportLink(prose)", supportLink("call us on the phone"), null)
    check("supportLink(empty)", supportLink("   "), null)

    serverPickerChecks()
    countryChecks()

    println(if (failures == 0) "all checks passed" else "$failures check(s) failed")
    if (failures > 0) kotlin.system.exitProcess(1)
}

/**
 * Server selection, which is the part of the app most able to be quietly wrong:
 * a bad order is not a crash, it is a slow connection nobody can explain.
 */
private fun server(host: String, state: RouteState, region: String? = null, label: String = host) = Server(
    profile = VlessProfile(
        uri = "vless://11111111-2222-3333-4444-555555555555@$host:443?type=ws&security=tls",
        uuid = "11111111-2222-3333-4444-555555555555",
        host = host,
        port = 443,
        label = label,
        tls = true,
        sni = null,
        wsPath = "/ws",
        wsHost = null,
    ),
    routeState = state,
    region = region,
)

/**
 * Countries are read from what the operator typed, so the checks are about not
 * inventing one: a region that is not an ISO country stays unplaced rather than
 * being drawn under somebody else's flag.
 */
private fun countryChecks() {
    check("region de-fra", countryOfRegion("de-fra")?.name, "Germany")
    check("region NL", countryOfRegion("NL")?.name, "Netherlands")
    check("region nl_ams", countryOfRegion("nl_ams")?.name, "Netherlands")
    check("region eu is not a country", countryOfRegion("eu"), null)
    check("region lab is not a country", countryOfRegion("lab"), null)
    check("region deutschland is not a code", countryOfRegion("deutschland"), null)
    check("region empty", countryOfRegion(""), null)
    check("region null", countryOfRegion(null), null)

    // Regional indicators: DE is U+1F1E9 U+1F1EA.
    check("flag DE", flagEmoji("DE")?.codePoints()?.toArray()?.toList(), listOf(0x1F1E9, 0x1F1EA))
    check("flag lower case", flagEmoji("de"), flagEmoji("DE"))
    check("flag of a non-code", flagEmoji("e"), null)

    // No region field (a base64 subscription): the label the control plane
    // writes is "Name · region", so the country is still recoverable.
    val fromLabel = server("gw1.example.net", RouteState.HEALTHY, region = null, label = "Frankfurt Edge · de-fra")
    check("country from the profile label", countryOf(fromLabel)?.code, "DE")

    val servers = listOf(
        server("gw1.example.net", RouteState.HEALTHY, region = "nl-ams"),
        server("gw2.example.net", RouteState.DEGRADED, region = "de-fra"),
        server("gw3.example.net", RouteState.HEALTHY, region = "de-fra"),
        server("gw4.example.net", RouteState.HEALTHY, region = "lab"),
    )
    val groups = groupByCountry(servers)
    check("grouped by country, unplaceable last", groups.map { it.key }, listOf("DE", "NL", CountryGroup.OTHER))
    check("two gateways in Germany", groups.first().servers.size, 2)
    check("a country takes its best route state", groups.first().routeState, RouteState.HEALTHY)
    check("the unplaceable group is named, not flagged", groups.last().country, null)
}

private fun serverPickerChecks() {
    val healthy = server("healthy.example.net", RouteState.HEALTHY)
    val degraded = server("degraded.example.net", RouteState.DEGRADED)
    val unverified = server("unverified.example.net", RouteState.UNVERIFIED)
    val all = listOf(degraded, unverified, healthy)

    // Health class beats latency: a fast gateway whose egress is struggling is
    // not a better route than a slower one that works end to end.
    val probes = mapOf(
        healthy.key to Probe(healthy.key, rttMs = 220, attempted = true),
        degraded.key to Probe(degraded.key, rttMs = 20, attempted = true),
        unverified.key to Probe(unverified.key, rttMs = 10, attempted = true),
    )
    check("health beats latency", ServerPicker.pick(all, probes)?.key, healthy.key)

    // Within a class, the faster one wins.
    val a = server("a.example.net", RouteState.HEALTHY)
    val b = server("b.example.net", RouteState.HEALTHY)
    val pair = listOf(a, b)
    check(
        "faster of two healthy",
        ServerPicker.pick(
            pair,
            mapOf(a.key to Probe(a.key, 180, true), b.key to Probe(b.key, 60, true)),
        )?.key,
        b.key,
    )

    // Hysteresis: a small gain does not justify dropping every open connection.
    check(
        "keeps current for a small gain",
        ServerPicker.pick(
            pair,
            mapOf(a.key to Probe(a.key, 100, true), b.key to Probe(b.key, 75, true)),
            current = a.key,
        )?.key,
        a.key,
    )
    check(
        "switches for a real gain",
        ServerPicker.pick(
            pair,
            mapOf(a.key to Probe(a.key, 100, true), b.key to Probe(b.key, 40, true)),
            current = a.key,
        )?.key,
        b.key,
    )

    // A server that stopped answering is not defended, and sorts last.
    check(
        "leaves a server that stopped answering",
        ServerPicker.pick(
            pair,
            mapOf(a.key to Probe(a.key, null, true), b.key to Probe(b.key, 300, true)),
            current = a.key,
        )?.key,
        b.key,
    )
    check(
        "unreachable sorts last",
        ServerPicker.rank(pair, mapOf(a.key to Probe(a.key, null, true), b.key to Probe(b.key, 900, true)))
            .map { it.key },
        listOf(b.key, a.key),
    )

    // Not measured is not the same as failed: it only sorts after measured ones.
    check(
        "unmeasured sorts after measured, not last",
        ServerPicker.rank(
            listOf(a, b, degraded),
            mapOf(b.key to Probe(b.key, 90, true)),
        ).map { it.key },
        listOf(b.key, a.key, degraded.key),
    )

    // Failover order keeps every server, including the ones that failed.
    check(
        "connect order tries the pick first and keeps the rest",
        ServerPicker.connectOrder(all, probes).map { it.key },
        listOf(healthy.key, degraded.key, unverified.key),
    )
    check("no servers, no pick", ServerPicker.pick(emptyList()), null)

    // End-to-end evidence outranks a first-hop handshake, in both directions:
    // a gateway that answers fast but cannot reach the internet goes last, and
    // a slower one that does reach it leads.
    val near = server("near.example.net", RouteState.HEALTHY)
    val far = server("far.example.net", RouteState.HEALTHY)
    val untested = server("untested.example.net", RouteState.HEALTHY)
    val three = listOf(near, far, untested)
    val handshakes = mapOf(
        near.key to Probe(near.key, 20, true),
        far.key to Probe(far.key, 150, true),
        untested.key to Probe(untested.key, 90, true),
    )
    check(
        "a dead egress loses to a slower working one",
        ServerPicker.connectOrder(
            three,
            handshakes,
            endToEnd = mapOf(near.key to null, far.key to 400),
        ).map { it.key },
        listOf(far.key, untested.key, near.key),
    )
    check(
        // Among untested servers the ordinary rank still decides, so the one
        // with the better handshake leads — and the proven-dead one is last.
        "an untested server outranks a proven-dead one",
        ServerPicker.connectOrder(three, handshakes, endToEnd = mapOf(near.key to null))
            .map { it.key },
        listOf(untested.key, far.key, near.key),
    )
    check(
        "end-to-end hysteresis keeps the server in use",
        ServerPicker.connectOrder(
            three,
            handshakes,
            endToEnd = mapOf(near.key to 300, far.key to 280),
            current = near.key,
        ).first().key,
        near.key,
    )
    check(
        "end-to-end switches when the gain is real",
        ServerPicker.connectOrder(
            three,
            handshakes,
            endToEnd = mapOf(near.key to 300, far.key to 150),
            current = near.key,
        ).first().key,
        far.key,
    )
}
