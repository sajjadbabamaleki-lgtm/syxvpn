package pro.syxvpn.app.core

import java.net.InetAddress

/**
 * Turns a gateway's name into an address the core can dial.
 *
 * libXray runs Xray inside a Go runtime, and Go's resolver cannot read
 * Android's DNS configuration — so the bridge points it at a fixed resolver
 * instead. On the networks this app exists for, that resolver is one of the
 * things that is blocked, and the result is a core that cannot turn a
 * gateway's name into an address at all: the tunnel fails before a packet is
 * sent, on a name the phone's own browser resolves in the same second.
 *
 * Every gateway until now was addressed by IP, so nothing asked. One behind a
 * CDN is addressed by name, and that is the case this exists for.
 *
 * The name is not discarded — it is still the certificate's name and still the
 * Host header. Only the address to connect to is settled here, by the phone
 * first and by DNS-over-HTTPS when the phone will not answer.
 */
object GatewayAddress {

    /**
     * [host] when it is already an address or cannot be resolved, otherwise the
     * address it resolves to.
     *
     * Never throws: a failure here must leave the caller with the name it
     * started with rather than no gateway at all — the core may still manage,
     * and a config that fails to connect is better than one that is never
     * built.
     */
    fun of(host: String, doh: DohResolver? = null): String {
        if (isLiteral(host)) return host
        // The phone's own resolver first: it is the one that works on a network
        // where anything works, and it is already warm from every other request
        // the app has made.
        runCatching { InetAddress.getByName(host).hostAddress }
            .getOrNull()
            ?.takeIf { it.isNotEmpty() }
            ?.let { return it }
        // Then the resolver that needs no resolver — addressed by IP, over
        // HTTPS, for the network that answers "no such host" on purpose.
        return doh?.let { resolver ->
            runCatching { resolver.addresses(host).firstOrNull() }.getOrNull()
        } ?: host
    }

    /**
     * Whether this is already an address rather than a name.
     *
     * Cheap and deliberate: anything that is only digits and dots, or carries a
     * colon, is not a name worth resolving. A hostname never looks like either.
     */
    fun isLiteral(host: String): Boolean =
        host.contains(':') || host.isNotEmpty() && host.all { it.isDigit() || it == '.' }
}
