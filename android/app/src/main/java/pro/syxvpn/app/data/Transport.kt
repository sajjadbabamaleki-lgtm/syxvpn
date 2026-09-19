package pro.syxvpn.app.data

import pro.syxvpn.app.core.DohResolver
import okhttp3.Dns
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

/** A status and a body: everything the callers of this file read. */
internal data class HttpReply(val status: Int, val body: String)

/**
 * One request, one answer.
 *
 * Two implementations exist for one reason: the second one can resolve a name
 * the phone cannot. It is not a preference or a rewrite — the ordinary path is
 * the platform's own client, unchanged, and the fallback is only reached when
 * that client cannot turn the host into an address at all.
 */
internal interface Transport {
    /** @throws UnknownHostException when the name cannot be resolved. */
    fun exchange(method: String, url: String, headers: Map<String, String>, body: String?): HttpReply
}

/** The platform's client, which is what every request uses until one cannot resolve. */
internal class SystemTransport : Transport {
    override fun exchange(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: String?,
    ): HttpReply {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            headers.forEach { (name, value) -> setRequestProperty(name, value) }
            if (body != null) doOutput = true
        }
        try {
            if (body != null) connection.outputStream.write(body.toByteArray())
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            return HttpReply(status, stream?.bufferedReader()?.readText().orEmpty())
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val CONNECT_TIMEOUT_MS = 10_000
        const val READ_TIMEOUT_MS = 15_000
    }
}

/**
 * The same request, with the address supplied by DNS-over-HTTPS.
 *
 * OkHttp is here for one method — `dns` — and it is the reason this is not the
 * platform client with a socket swapped underneath it: pinning an address by
 * putting it in the URL costs the hostname, and with it the SNI the gateway
 * selects a certificate by and the name the certificate is checked against.
 * The URL keeps the real host; only the address it resolves to is ours.
 */
internal class DohTransport(private val resolver: DohResolver) : Transport {
    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .dns(object : Dns {
                override fun lookup(hostname: String): List<InetAddress> {
                    // Built with the hostname attached, so anything downstream
                    // that asks the address what it is called hears the name.
                    val resolved = resolver.addresses(hostname).mapNotNull { address ->
                        DohResolver.ipv4Bytes(address)?.let { bytes ->
                            runCatching { InetAddress.getByAddress(hostname, bytes) }.getOrNull()
                        }
                    }
                    if (resolved.isEmpty()) throw UnknownHostException("no DoH answer for $hostname")
                    return resolved
                }
            })
            .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .readTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .build()
    }

    override fun exchange(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: String?,
    ): HttpReply {
        // OkHttp is stricter than HttpURLConnection about bodies: a POST
        // without one is rejected outright rather than sent empty, and this
        // path must behave the same as the one it stands in for.
        val payload = when {
            body != null -> body.toRequestBody(JSON)
            method in BODY_REQUIRED -> ByteArray(0).toRequestBody(JSON)
            else -> null
        }
        val request = Request.Builder()
            .url(url)
            .method(method, payload)
            .apply { headers.forEach { (name, value) -> header(name, value) } }
            .build()
        client.newCall(request).execute().use { response ->
            return HttpReply(response.code, response.body?.string().orEmpty())
        }
    }

    private companion object {
        const val CONNECT_TIMEOUT_SECONDS = 10L
        const val READ_TIMEOUT_SECONDS = 15L
        val JSON = "application/json; charset=utf-8".toMediaType()
        val BODY_REQUIRED = setOf("POST", "PUT", "PATCH")
    }
}

/**
 * The ordinary client, then the one that can resolve for itself.
 *
 * Only an unresolvable name falls through. A refused connection, a timeout or
 * an error status is the server's answer and is passed straight up: retrying
 * those over a second transport would double every real failure's wait.
 */
internal class ResilientTransport(
    private val ordinary: Transport,
    private val fallback: Transport,
) : Transport {
    override fun exchange(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: String?,
    ): HttpReply = try {
        ordinary.exchange(method, url, headers, body)
    } catch (unresolved: UnknownHostException) {
        try {
            fallback.exchange(method, url, headers, body)
        } catch (stillUnresolved: UnknownHostException) {
            // The first failure is the one worth reporting: it is the phone's
            // own answer, and the person reading it is not debugging our
            // fallback.
            stillUnresolved.initCause(unresolved)
            throw stillUnresolved
        }
    }
}

/**
 * The same request, sent through the tunnel this phone already has.
 *
 * The other transports here answer a name the phone cannot resolve. This one
 * answers a name the phone resolves perfectly well and then cannot connect to:
 * a control-plane address filtered on this network, where the handshake is cut
 * and no resolver changes that. The tunnel is the one road out that is not
 * subject to it, so when it is up the request goes down a SOCKS door the core
 * opened on loopback and leaves the country before it asks for anything.
 *
 * The host stays a host: OkHttp hands an unresolved address to a SOCKS proxy,
 * so the name is resolved at the far end — which matters, because the resolver
 * on this side is the other thing that lies about these names.
 *
 * @param port reads the loopback port of the running tunnel, or null when
 *   there is no tunnel. It is read per request: the tunnel comes and goes.
 */
internal class TunnelTransport(private val port: () -> Int?) : Transport {
    private var cached: Pair<Int, OkHttpClient>? = null

    private fun clientFor(proxyPort: Int): OkHttpClient {
        cached?.let { (known, client) -> if (known == proxyPort) return client }
        // Connection pool and threads are the client's, so one per port rather
        // than one per request; the port changes only when a tunnel restarts.
        val client = OkHttpClient.Builder()
            .proxy(Proxy(Proxy.Type.SOCKS, InetSocketAddress.createUnresolved("127.0.0.1", proxyPort)))
            .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .readTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .build()
        cached = proxyPort to client
        return client
    }

    override fun exchange(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: String?,
    ): HttpReply {
        val proxyPort = port() ?: throw IOException("no tunnel to send this through")
        val payload = when {
            body != null -> body.toRequestBody(JSON)
            method in BODY_REQUIRED -> ByteArray(0).toRequestBody(JSON)
            else -> null
        }
        val request = Request.Builder()
            .url(url)
            .method(method, payload)
            .apply { headers.forEach { (name, value) -> header(name, value) } }
            .build()
        clientFor(proxyPort).newCall(request).execute().use { response ->
            return HttpReply(response.code, response.body?.string().orEmpty())
        }
    }

    private companion object {
        const val CONNECT_TIMEOUT_SECONDS = 10L
        const val READ_TIMEOUT_SECONDS = 15L
        val JSON = "application/json; charset=utf-8".toMediaType()
        val BODY_REQUIRED = setOf("POST", "PUT", "PATCH")
    }
}

/**
 * One transport, then another, for any failure to reach the far end.
 *
 * [ResilientTransport] moves on for one reason — a name that will not resolve —
 * and that is deliberate: it must not turn one real failure into two waits.
 * This one moves on for any IOException, because what it stands in front of is
 * not a second opinion about the same road but a different road entirely, and
 * the failure that sends it there is the whole reason the second road exists.
 *
 * A road that has just worked is tried first for a while. Without that, every
 * request on a filtered network pays the first road's full connect timeout
 * before reaching the one that answers — ten seconds on each of sign-in, plans
 * and subscription, which is the difference between an app that feels slow and
 * one that feels broken. The preference lapses on its own, so a network that
 * recovers is noticed rather than waited out.
 *
 * @param now supplied so the lapse can be tested without sleeping.
 */
internal class EitherTransport(
    private val first: Transport,
    private val second: Transport,
    private val stickyMs: Long = 5 * 60 * 1000,
    private val now: () -> Long = System::currentTimeMillis,
) : Transport {
    /** When the preference for the second road expires; 0 means no preference. */
    @Volatile private var preferSecondUntil = 0L

    override fun exchange(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: String?,
    ): HttpReply {
        val preferSecond = now() < preferSecondUntil
        val (ordinary, other) = if (preferSecond) second to first else first to second
        return try {
            ordinary.exchange(method, url, headers, body)
        } catch (unreachable: IOException) {
            val reply = try {
                other.exchange(method, url, headers, body)
            } catch (alsoUnreachable: IOException) {
                // Both roads are gone: no preference is worth keeping, and the
                // ordinary road's failure is the one a person is looking at.
                preferSecondUntil = 0L
                alsoUnreachable.initCause(unreachable)
                throw alsoUnreachable
            }
            preferSecondUntil = if (preferSecond) 0L else now() + stickyMs
            reply
        }
    }
}

/**
 * A DoH resolver that fetches over the platform client, addressed by IP.
 *
 * No name is involved in reaching the resolver, so this works in exactly the
 * situation it exists for.
 */
internal fun systemDohResolver(): DohResolver = DohResolver(fetch = { url ->
    val connection = (URL(url).openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        connectTimeout = 8_000
        readTimeout = 8_000
        setRequestProperty("Accept", "application/dns-json")
    }
    try {
        if (connection.responseCode !in 200..299) error("resolver answered ${connection.responseCode}")
        connection.inputStream.bufferedReader().readText()
    } finally {
        connection.disconnect()
    }
})
