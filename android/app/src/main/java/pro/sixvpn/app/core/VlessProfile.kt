package pro.sixvpn.app.core

/**
 * A parsed `vless://` profile.
 *
 * This is the FIRST HOP only: it says how to reach a gateway, and nothing about
 * how that gateway reaches the internet. Route selection happens in the control
 * plane; the client simply uses whichever gateways the subscription currently
 * hands out.
 */
data class VlessProfile(
    /** The original `vless://` line, kept so it can be copied or shared. */
    override val uri: String,
    val uuid: String,
    override val host: String,
    override val port: Int,
    override val label: String,
    val tls: Boolean,
    val sni: String?,
    val wsPath: String,
    val wsHost: String?,
    /**
     * REALITY, when the gateway borrows a real site's TLS handshake instead of
     * serving a certificate of its own. Null on a WebSocket profile, which is
     * every profile issued before this existed.
     */
    val reality: Reality? = null,
) : TunnelProfile {

    override val protocolLabel: String get() = when {
        reality != null -> "vless · tcp · reality"
        tls -> "vless · ws · tls"
        else -> "vless · ws"
    }

    /**
     * What a client needs to be recognised by a REALITY gateway.
     *
     * The public key and the short ID are what separate a subscriber from a
     * censor's prober: without them the gateway forwards the connection to the
     * borrowed site, and the prober gets that site's real certificate back.
     */
    data class Reality(
        val publicKey: String,
        val shortId: String,
        val serverName: String,
        val fingerprint: String,
        /** Vision. It shapes packets like a browser's; REALITY without it is thinner cover. */
        val flow: String,
    )

    companion object {
        fun parse(uri: String): VlessProfile? {
            if (!uri.startsWith("vless://")) return null
            val parsed = UriParts.parse(uri) ?: return null
            val uuid = parsed.userInfo ?: return null
            val host = parsed.host?.takeIf { it.isNotEmpty() } ?: return null
            val port = parsed.port?.takeIf { it in 1..65535 } ?: return null
            val security = parsed.param("security") ?: "none"
            val type = parsed.param("type") ?: "ws"

            if (security == "reality") {
                // REALITY runs over plain TCP here, and its public key is the
                // one thing that cannot be defaulted: without it there is
                // nothing to encrypt to.
                if (type != "tcp") return null
                val publicKey = parsed.param("pbk")?.takeIf { it.isNotBlank() } ?: return null
                return VlessProfile(
                    uri = uri,
                    uuid = uuid,
                    host = host,
                    port = port,
                    label = parsed.fragment ?: host,
                    tls = true,
                    sni = parsed.param("sni"),
                    wsPath = "/",
                    wsHost = null,
                    reality = Reality(
                        publicKey = publicKey,
                        shortId = parsed.param("sid") ?: "",
                        // The name claimed in the handshake: the borrowed
                        // site's, never the gateway's own address.
                        serverName = parsed.param("sni") ?: host,
                        fingerprint = parsed.param("fp") ?: "chrome",
                        flow = parsed.param("flow") ?: "xtls-rprx-vision",
                    ),
                )
            }

            // Otherwise ws, which is all the control plane generated before
            // REALITY; anything else is rejected rather than misconfigured.
            if (type != "ws") return null
            return VlessProfile(
                uri = uri,
                uuid = uuid,
                host = host,
                port = port,
                label = parsed.fragment ?: host,
                tls = security == "tls",
                sni = parsed.param("sni"),
                wsPath = parsed.param("path") ?: "/ws",
                wsHost = parsed.param("host"),
            )
        }
    }
}
