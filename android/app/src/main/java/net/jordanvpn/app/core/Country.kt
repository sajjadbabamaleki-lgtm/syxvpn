package net.jordanvpn.app.core

import java.util.Locale

/**
 * A country, worked out from what the control plane already publishes.
 *
 * Nothing here is invented. A gateway carries a free-text `region`, and the
 * convention this control plane uses is an ISO country code first — `de-fra`,
 * `nl-ams`, `tr-ist`. When that is what the region looks like, and the code is a
 * real ISO country, the phone can name it and show its flag. When it is not —
 * `eu`, `lab`, anything an operator typed — there is no country, and the row
 * says so by showing the gateway's own name instead of a flag it guessed.
 */
data class Country(val code: String, val name: String, val flag: String)

/**
 * The flag as regional-indicator letters, which is how every phone draws one
 * without shipping image assets.
 */
fun flagEmoji(code: String): String? {
    val upper = code.uppercase(Locale.US)
    if (upper.length != 2 || upper.any { it !in 'A'..'Z' }) return null
    val base = 0x1F1E6
    return String(Character.toChars(base + (upper[0] - 'A'))) +
        String(Character.toChars(base + (upper[1] - 'A')))
}

private val isoCountries: Set<String> by lazy { Locale.getISOCountries().toSet() }

/** Turns `de-fra`, `DE` or `de_fra` into Germany. Anything else returns null. */
fun countryOfRegion(region: String?): Country? {
    val trimmed = region?.trim().orEmpty()
    if (trimmed.length < 2) return null
    val head = trimmed.take(2).uppercase(Locale.US)
    // Two letters, then either nothing or a separator: "de", "de-fra", "de_fra".
    if (head.any { it !in 'A'..'Z' }) return null
    if (trimmed.length > 2 && trimmed[2] != '-' && trimmed[2] != '_') return null
    if (head !in isoCountries) return null
    val name = Locale.Builder().setRegion(head).build().getDisplayCountry(Locale.ENGLISH)
    val flag = flagEmoji(head) ?: return null
    return Country(head, name.ifEmpty { head }, flag)
}

/**
 * The same, but also willing to read the label the control plane writes into a
 * profile — `Frankfurt Edge · de-fra` — because a subscription fetched as a
 * plain base64 list carries no region field at all.
 */
fun countryOf(server: Server): Country? =
    countryOfRegion(server.region)
        ?: countryOfRegion(server.profile.label.substringAfterLast('·').trim())

/** One country, and the gateways in it. */
data class CountryGroup(
    val country: Country?,
    val servers: List<Server>,
) {
    /** Stable identity: the ISO code, or "other" for the unplaceable ones. */
    val key: String get() = country?.code ?: OTHER

    val name: String get() = country?.name ?: "Other servers"

    /** The worst thing the control plane says about any route in this country. */
    val routeState: RouteState
        get() = servers.minByOrNull { it.routeState.rank }?.routeState ?: RouteState.UNKNOWN

    companion object {
        const val OTHER = "other"
    }
}

/**
 * Groups the subscription's servers by country, for the plain VPN screen.
 *
 * Order is by name so the list does not jump around between refreshes, with the
 * unplaceable servers last — they are still offered, just not pretending to be
 * somewhere. A country keeps its servers in the order the control plane gave
 * them, which is its own priority.
 */
fun groupByCountry(servers: List<Server>): List<CountryGroup> {
    val groups = LinkedHashMap<String, MutableList<Server>>()
    val countries = HashMap<String, Country?>()
    servers.forEach { server ->
        val country = countryOf(server)
        val key = country?.code ?: CountryGroup.OTHER
        countries[key] = country
        groups.getOrPut(key) { mutableListOf() }.add(server)
    }
    return groups.map { (key, list) -> CountryGroup(countries[key], list) }
        .sortedWith(compareBy({ if (it.country == null) 1 else 0 }, { it.name }))
}
