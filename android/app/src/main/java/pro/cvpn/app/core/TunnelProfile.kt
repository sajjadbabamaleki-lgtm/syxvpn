package pro.cvpn.app.core

/**
 * One way into one gateway.
 *
 * The app used to know exactly one shape of profile, and the type said so
 * everywhere: `VlessProfile` was the type of a server, of a config someone
 * pasted, of the thing the tunnel is built from. A fleet with one protocol is
 * one thing for a censor to learn, so a gateway now offers several — and the
 * client has to be able to hold all of them at once, measure them against each
 * other, and move between them.
 *
 * What every kind promises is the same, and it is small: the FIRST HOP. A
 * profile says how to reach a gateway. It says nothing about how that gateway
 * reaches the internet, which is the control plane's business and is not
 * visible from here at all.
 *
 * [parse] is the one door in. Everything that reads a line — a subscription, a
 * clipboard, a QR code somebody was sent — goes through it, so a protocol is
 * added in exactly one place and no caller has to know the list.
 */
sealed interface TunnelProfile {
    /** The original line, kept so it can be copied, shared or stored verbatim. */
    val uri: String
    val host: String
    val port: Int
    val label: String

    /**
     * What this is, in the words the connection screen shows: `vless · ws · tls`,
     * `shadowsocks · 2022-blake3-aes-256-gcm`, `trojan · tls`.
     *
     * It belongs to the profile rather than to the screen. A screen that works
     * this out from the fields has to be edited every time a protocol is added,
     * and the one that is not edited quietly labels the new thing as the old.
     */
    val protocolLabel: String

    companion object {
        /** The scheme of every line this app can turn into a tunnel. */
        val SCHEMES = listOf("vless://", "ss://", "trojan://")

        /** Whether a line is worth trying to parse — not whether it will work. */
        fun looksLikeProfile(line: String): Boolean = SCHEMES.any { line.startsWith(it) }

        fun parse(line: String): TunnelProfile? {
            val trimmed = line.trim()
            return when {
                trimmed.startsWith("vless://") -> VlessProfile.parse(trimmed)
                trimmed.startsWith("ss://") -> ShadowsocksProfile.parse(trimmed)
                trimmed.startsWith("trojan://") -> TrojanProfile.parse(trimmed)
                else -> null
            }
        }
    }
}

/**
 * A Shadowsocks profile, in the SIP002 form.
 *
 * The credential is a method and a password, and for the 2022 methods the
 * password is itself two keys joined by a colon — the inbound's and the
 * subscriber's. Nothing here needs to know that: it is one opaque string to
 * everything between the control plane that wrote it and the core that uses it.
 *
 * Two encodings exist in the wild and both are accepted, because a person
 * pasting a line bought somewhere else did not choose which one they were
 * given:
 *
 *     ss://<base64url(method:password)>@host:port#label      (SIP002)
 *     ss://<base64(method:password@host:port)>#label         (the older form)
 */
data class ShadowsocksProfile(
    override val uri: String,
    override val host: String,
    override val port: Int,
    override val label: String,
    val method: String,
    val password: String,
) : TunnelProfile {

    override val protocolLabel: String get() = "shadowsocks · $method"

    companion object {
        fun parse(uri: String): ShadowsocksProfile? {
            if (!uri.startsWith("ss://")) return null
            val withoutScheme = uri.removePrefix("ss://")
            val body = withoutScheme.substringBefore('#')
            val label = withoutScheme.substringAfter('#', "")
                .takeIf { it.isNotEmpty() }
                ?.let { UriParts.decode(it) }

            if ('@' in body) {
                val credential = decodeCredential(body.substringBeforeLast('@')) ?: return null
                val hostPort = body.substringAfterLast('@').substringBefore('?')
                val host = hostPort.substringBeforeLast(':').trim('[', ']')
                val port = hostPort.substringAfterLast(':').toIntOrNull() ?: return null
                if (host.isEmpty() || port !in 1..65535) return null
                return ShadowsocksProfile(
                    uri = uri,
                    host = host,
                    port = port,
                    label = label ?: "$host:$port",
                    method = credential.first,
                    password = credential.second,
                )
            }

            // The older form: everything, including the address, inside one blob.
            val decoded = decodeBase64(body.substringBefore('?')) ?: return null
            val credential = decodeCredentialText(decoded.substringBeforeLast('@')) ?: return null
            val hostPort = decoded.substringAfterLast('@')
            val host = hostPort.substringBeforeLast(':').trim('[', ']')
            val port = hostPort.substringAfterLast(':').toIntOrNull() ?: return null
            if (host.isEmpty() || port !in 1..65535) return null
            return ShadowsocksProfile(
                uri = uri,
                host = host,
                port = port,
                label = label ?: "$host:$port",
                method = credential.first,
                password = credential.second,
            )
        }

        /**
         * The userinfo of a SIP002 line.
         *
         * It is usually base64, and it is sometimes not: some issuers write the
         * method and password in the clear, and a client that only accepts one
         * of those rejects a line that works everywhere else.
         */
        private fun decodeCredential(value: String): Pair<String, String>? =
            decodeCredentialText(decodeBase64(value) ?: value)

        private fun decodeCredentialText(value: String): Pair<String, String>? {
            // The password of a 2022 method contains a colon of its own, so the
            // split is on the FIRST one: everything after it is the password.
            val method = value.substringBefore(':', "")
            val password = value.substringAfter(':', "")
            if (method.isEmpty() || password.isEmpty()) return null
            return method to password
        }

        /**
         * The credential blob of a `ss://` line.
         *
         * Anything that is not a credential is not one: the caller's split
         * needs a colon, and garbage that happened to decode cleanly has none.
         */
        private fun decodeBase64(value: String): String? =
            Base64Text.decode(value)?.takeIf { ':' in it }
    }
}

/**
 * A Trojan profile.
 *
 * Trojan is defined over TLS and has no meaning without it: the disguise is
 * that a wrong password gets the web server behind it rather than an error, and
 * there is no web server without a certificate. So `security` is not read as a
 * switch here — a line that says `security=none` is a line that cannot work,
 * and is refused rather than turned into a tunnel that fails on the phone.
 */
data class TrojanProfile(
    override val uri: String,
    override val host: String,
    override val port: Int,
    override val label: String,
    val password: String,
    /** The name to claim in the handshake; the certificate has to carry it. */
    val sni: String,
    /** Which browser's ClientHello to imitate, when the core supports it. */
    val fingerprint: String?,
) : TunnelProfile {

    override val protocolLabel: String get() = "trojan · tls"

    companion object {
        fun parse(uri: String): TrojanProfile? {
            if (!uri.startsWith("trojan://")) return null
            val parts = UriParts.parse(uri) ?: return null
            val password = parts.userInfo?.takeIf { it.isNotEmpty() } ?: return null
            val host = parts.host?.takeIf { it.isNotEmpty() } ?: return null
            val port = parts.port?.takeIf { it in 1..65535 } ?: return null
            // Absent means TLS: every trojan line that predates the parameter is
            // TLS, because the protocol has never been anything else.
            val security = parts.param("security") ?: "tls"
            if (security != "tls" && security != "reality") return null
            if (security == "reality") return null
            return TrojanProfile(
                uri = uri,
                host = host,
                port = port,
                label = parts.fragment ?: "$host:$port",
                password = password,
                sni = parts.param("sni")?.takeIf { it.isNotBlank() } ?: host,
                fingerprint = parts.param("fp")?.takeIf { it.isNotBlank() },
            )
        }
    }
}
