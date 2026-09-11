package pro.sixvpn.app.core

/**
 * Which resolver the tunnel uses, and whether the queries are encrypted.
 *
 * A tunnel that carries the traffic but leaks the names is half a tunnel. The
 * app used to hand the TUN interface two plain resolvers and let every query
 * leave as clear-text UDP on port 53: inside the tunnel, so the local network
 * could not read it, but readable at the other end of it and rewritable by
 * anything on the path beyond.
 *
 * Each encrypted mode is a DNS-over-HTTPS endpoint, and every endpoint here is
 * addressed by IP rather than by name. A resolver reached by name needs a
 * resolver to reach it, and the query that bootstraps DNS is exactly the query
 * nobody is encrypting. The same rule the control-plane resolver follows
 * ([DohResolver]), for the same reason.
 *
 * The answer never leaves the device either way: nothing here is reported, and
 * which mode is set is stored on the phone alone.
 *
 * @param label what the person picking it sees.
 * @param detail one line under the label; no claim here that the resolver
 *   itself cannot see the query, because it can — encryption hides it from the
 *   path, not from the far end.
 * @param dohUrl the DoH endpoint, or null for the plain resolvers the app used
 *   before this existed. That null is the rollback: [STANDARD] generates byte
 *   for byte the configuration that shipped.
 * @param addresses what the TUN interface advertises to the system. Queries to
 *   them are captured by the tunnel and re-issued over [dohUrl] when there is
 *   one, so on an encrypted mode these addresses are what Android shows in its
 *   network details and not where the query actually goes.
 */
enum class PrivateDns(
    val label: String,
    val detail: String,
    val dohUrl: String?,
    val addresses: List<String>,
) {
    STANDARD(
        label = "Standard",
        detail = "Plain DNS inside the tunnel, as before",
        dohUrl = null,
        addresses = listOf("1.1.1.1", "8.8.8.8"),
    ),

    CLOUDFLARE(
        label = "Cloudflare",
        detail = "Encrypted to 1.1.1.1",
        dohUrl = "https://1.1.1.1/dns-query",
        addresses = listOf("1.1.1.1", "1.0.0.1"),
    ),

    GOOGLE(
        label = "Google",
        detail = "Encrypted to 8.8.8.8",
        dohUrl = "https://8.8.8.8/dns-query",
        addresses = listOf("8.8.8.8", "8.8.4.4"),
    ),

    QUAD9(
        label = "Quad9",
        detail = "Encrypted to 9.9.9.9, and it refuses known-malicious names",
        dohUrl = "https://9.9.9.9/dns-query",
        addresses = listOf("9.9.9.9", "149.112.112.112"),
    ),
    ;

    /** Whether queries leave this phone as DoH rather than as clear-text UDP. */
    val encrypted: Boolean get() = dohUrl != null

    companion object {
        /** What a phone that has never been asked gets. */
        val DEFAULT = CLOUDFLARE

        /**
         * The mode stored under [value], or [DEFAULT] when it is missing or is
         * a name this build does not know — a mode removed in a later version
         * must not leave the tunnel without a resolver.
         */
        fun of(value: String?): PrivateDns =
            entries.firstOrNull { it.name.equals(value, ignoreCase = true) } ?: DEFAULT
    }
}
