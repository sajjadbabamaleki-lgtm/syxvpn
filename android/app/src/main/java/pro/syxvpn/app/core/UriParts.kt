package pro.syxvpn.app.core

/**
 * Just enough URI parsing to read a `vless://` line, written by hand.
 *
 * It replaces android.net.Uri here for one reason that matters more than it
 * sounds: android.net.Uri is a stub on a JVM test runner, so every test of the
 * most security-relevant parser in the app was impossible to write. A profile
 * that parses wrong is a tunnel to somewhere else, or no tunnel at all, and
 * until now the only proof it worked was that it seemed to.
 *
 * java.net.URI would have been the obvious replacement and is the wrong one:
 * it is strict about characters that these links carry all the time. The
 * fragment on a real profile is a human-readable label — spaces, "·", Persian
 * — usually not percent-encoded, and java.net.URI throws on it.
 *
 * Decoding follows android.net.Uri deliberately, including the part people get
 * wrong: `+` is a literal plus, not a space. That convention belongs to HTML
 * form encoding, and a WebSocket path of `/ws+1` is a real path.
 */
internal data class UriParts(
    val scheme: String,
    val userInfo: String?,
    val host: String?,
    val port: Int?,
    val query: Map<String, String>,
    val fragment: String?,
) {
    fun param(name: String): String? = query[name]

    companion object {
        fun parse(raw: String): UriParts? {
            val schemeEnd = raw.indexOf("://")
            if (schemeEnd <= 0) return null
            val scheme = raw.substring(0, schemeEnd).lowercase()
            var rest = raw.substring(schemeEnd + 3)

            // Fragment first, then query: both are cut from the right, and a
            // label is free to contain '?' — "Berlin · fast?" is a label.
            var fragment: String? = null
            val hash = rest.indexOf('#')
            if (hash >= 0) {
                fragment = percentDecode(rest.substring(hash + 1))
                rest = rest.substring(0, hash)
            }

            var query: Map<String, String> = emptyMap()
            val mark = rest.indexOf('?')
            if (mark >= 0) {
                query = parseQuery(rest.substring(mark + 1))
                rest = rest.substring(0, mark)
            }

            // The last '@', not the first: a userinfo may contain one encoded,
            // and the host never does.
            var userInfo: String? = null
            val at = rest.lastIndexOf('@')
            if (at >= 0) {
                userInfo = percentDecode(rest.substring(0, at)).takeIf { it.isNotEmpty() }
                rest = rest.substring(at + 1)
            }

            val (host, port) = splitHostPort(rest) ?: return null
            return UriParts(scheme, userInfo, host, port, query, fragment)
        }

        /** `host:port`, `[v6]:port`, or either without a port. */
        private fun splitHostPort(authority: String): Pair<String?, Int?>? {
            if (authority.isEmpty()) return null
            if (authority.startsWith("[")) {
                val close = authority.indexOf(']')
                if (close < 0) return null
                val host = authority.substring(1, close)
                val tail = authority.substring(close + 1)
                if (tail.isEmpty()) return host to null
                if (!tail.startsWith(":")) return null
                val port = tail.substring(1).toIntOrNull() ?: return null
                return host to port
            }
            val colon = authority.lastIndexOf(':')
            // No colon, or more than one and no brackets — the second is a bare
            // IPv6 address, which is not a thing a URI authority may hold.
            if (colon < 0) return authority to null
            if (authority.indexOf(':') != colon) return null
            val host = authority.substring(0, colon)
            if (host.isEmpty()) return null
            val port = authority.substring(colon + 1).toIntOrNull() ?: return null
            return host to port
        }

        /**
         * Percent-decoding on its own.
         *
         * For the schemes that are not URIs: a Shadowsocks line's label is
         * percent-encoded in the same way, but everything before it is base64
         * and has no business going through a URI parser.
         */
        fun decode(value: String): String = percentDecode(value)

        /** First value wins, which is what android.net.Uri returns. */
        private fun parseQuery(raw: String): Map<String, String> {
            val out = LinkedHashMap<String, String>()
            for (pair in raw.split('&')) {
                if (pair.isEmpty()) continue
                val eq = pair.indexOf('=')
                val name = percentDecode(if (eq < 0) pair else pair.substring(0, eq))
                val value = if (eq < 0) "" else percentDecode(pair.substring(eq + 1))
                if (name.isNotEmpty() && !out.containsKey(name)) out[name] = value
            }
            return out
        }

        /**
         * %XX only.
         *
         * Consecutive escapes are gathered and read as UTF-8 together: one
         * Persian character is two escapes and a flag emoji is eight, and
         * decoding them one at a time produces mojibake rather than a label.
         *
         * Characters that were not escaped are appended as they are, never
         * re-encoded. Encoding a lone surrogate — half of an emoji — yields a
         * question mark, and half of every flag in a server list would be
         * exactly the kind of damage nobody traces back to a URI parser.
         *
         * Anything that is not a valid escape is left as written rather than
         * dropped: a stray '%' in a label is a '%'.
         */
        fun percentDecode(raw: String): String {
            if (!raw.contains('%')) return raw
            val out = StringBuilder(raw.length)
            val pending = ArrayList<Byte>(4)
            fun flush() {
                if (pending.isEmpty()) return
                out.append(String(pending.toByteArray(), Charsets.UTF_8))
                pending.clear()
            }
            var i = 0
            while (i < raw.length) {
                val c = raw[i]
                if (c == '%' && i + 2 < raw.length) {
                    val value = raw.substring(i + 1, i + 3).toIntOrNull(16)
                    if (value != null) {
                        pending.add(value.toByte())
                        i += 3
                        continue
                    }
                }
                flush()
                out.append(c)
                i += 1
            }
            flush()
            return out.toString()
        }
    }
}
