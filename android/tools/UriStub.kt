package android.net

/**
 * Stand-in for android.net.Uri, only for checking the config builder off-device.
 * It parses the same shapes VlessProfile reads out of a vless:// line.
 */
class Uri private constructor(private val raw: String) {
    private val afterScheme = raw.substringAfter("://")
    private val beforeFragment = afterScheme.substringBefore('#')
    private val authority = beforeFragment.substringBefore('?').substringBefore('/')
    private val query = if ('?' in beforeFragment) beforeFragment.substringAfter('?') else ""

    val userInfo: String? = authority.substringBefore('@').takeIf { '@' in authority }
    private val hostPort = if ('@' in authority) authority.substringAfter('@') else authority
    val host: String? = hostPort.substringBefore(':').takeIf { it.isNotEmpty() }
    val port: Int = hostPort.substringAfter(':', "").toIntOrNull() ?: -1
    val fragment: String? = afterScheme.substringAfter('#', "").takeIf { it.isNotEmpty() }
        ?.let { java.net.URLDecoder.decode(it, "UTF-8") }

    fun getQueryParameter(name: String): String? = query.split('&')
        .mapNotNull { pair ->
            val key = pair.substringBefore('=')
            if (key == name) java.net.URLDecoder.decode(pair.substringAfter('=', ""), "UTF-8") else null
        }
        .firstOrNull()

    companion object {
        @JvmStatic fun parse(value: String) = Uri(value)
    }
}
