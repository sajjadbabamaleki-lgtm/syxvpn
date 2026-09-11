package pro.syxvpn.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Resolves a name without asking the phone.
 *
 * The app cannot open its tunnel until it has reached the control plane, and it
 * reaches the control plane by name — so on a network where that name does not
 * resolve, the app is finished before it starts. That is not a hypothetical: a
 * VPN already holding the resolver, or an ISP answering "no such host" for a
 * VPN's domain, both produce it, and both look to the person holding the phone
 * like the app is broken.
 *
 * This asks a DNS-over-HTTPS resolver instead. The endpoints are addressed by
 * IP on purpose: a resolver reached by name is no help when names are what
 * stopped working. Both providers carry those addresses in their certificates,
 * so TLS still verifies against a real identity rather than being waved past.
 *
 * The class holds no transport of its own — `fetch` is handed in — so it is
 * testable without a network and cannot become a second HTTP stack.
 */
class DohResolver(
    private val fetch: (url: String) -> String,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val endpoints: List<String> = DEFAULT_ENDPOINTS,
) {
    private data class Cached(val addresses: List<String>, val expiresAt: Long)

    private val cache = mutableMapOf<String, Cached>()
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * The addresses for [host], or an empty list when no endpoint answered with
     * one. Answers are cached for the TTL the resolver gave, bounded at both
     * ends: a one-second TTL would make this a resolver call per request, and a
     * day-long one would outlive a gateway move.
     */
    fun addresses(host: String): List<String> {
        cache[host]?.let { if (it.expiresAt > now()) return it.addresses }
        for (endpoint in endpoints) {
            val answer = runCatching { parse(fetch(endpoint + host)) }.getOrNull() ?: continue
            if (answer.addresses.isEmpty()) continue
            cache[host] = Cached(answer.addresses, now() + answer.ttlSeconds * 1000L)
            return answer.addresses
        }
        return emptyList()
    }

    /** Drops a cached answer, for when an address stops working mid-session. */
    fun forget(host: String) {
        cache.remove(host)
    }

    private data class Answer(val addresses: List<String>, val ttlSeconds: Long)

    /**
     * Both providers speak the same JSON shape, so one parser serves both.
     *
     * Only A records are taken. An answer chain can carry the CNAMEs it walked
     * through, and a CNAME's data is a name — feeding that back as an address
     * would be a resolution that resolves to nothing.
     */
    private fun parse(text: String): Answer {
        val root = json.parseToJsonElement(text) as? JsonObject ?: return Answer(emptyList(), MIN_TTL_SECONDS)
        val records = (root["Answer"] as? JsonArray)
            ?.mapNotNull { it as? JsonObject }
            ?.filter { it["type"]?.jsonPrimitive?.intOrNull == TYPE_A }
            .orEmpty()
        val addresses = records
            .mapNotNull { it["data"]?.jsonPrimitive?.contentOrNull }
            .filter { IPV4.matches(it) }
        val ttl = records.mapNotNull { it["TTL"]?.jsonPrimitive?.intOrNull?.toLong() }.minOrNull()
            ?: MIN_TTL_SECONDS
        return Answer(addresses, ttl.coerceIn(MIN_TTL_SECONDS, MAX_TTL_SECONDS))
    }

    companion object {
        /**
         * Cloudflare first, Google second: two operators rather than two
         * addresses of one, so a single provider being unreachable — or being
         * the thing that is blocked — is not the end of it.
         */
        val DEFAULT_ENDPOINTS = listOf(
            "https://1.1.1.1/dns-query?type=A&name=",
            "https://8.8.8.8/resolve?type=A&name=",
        )

        const val MIN_TTL_SECONDS = 60L
        const val MAX_TTL_SECONDS = 3600L

        private const val TYPE_A = 1
        private val IPV4 = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""")

        /** The four bytes of a dotted quad, or null when it is not one. */
        fun ipv4Bytes(address: String): ByteArray? {
            val parts = IPV4.matchEntire(address)?.groupValues?.drop(1) ?: return null
            val octets = parts.map { it.toIntOrNull() ?: return null }
            if (octets.any { it !in 0..255 }) return null
            return ByteArray(4) { octets[it].toByte() }
        }
    }
}
