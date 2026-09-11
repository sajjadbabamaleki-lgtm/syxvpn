package pro.sixvpn.app.vpn

import android.util.Log
import libXray.DialerController
import libXray.LibXray
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * The real runtime: Xray-core through libXray's gomobile binding.
 *
 * libXray exposes exactly one entry point — `Invoke(requestJSON) string` with
 * `apiVersion: 3` — so every call here is a small JSON envelope in and a
 * `{success, data, error}` envelope out. The methods used are `runXray`,
 * `stopXray`, `getXrayState` and `xrayVersion`.
 *
 * Two things have to happen before the core starts, and both are the reason a
 * VPN app cannot simply "run Xray":
 *
 *  1. Every socket the core opens is protected, through the dialer and listener
 *     controllers. The connection to the gateway must not be routed into the
 *     tunnel it is carrying.
 *  2. Go's own resolver is pointed at a real DNS server. While a VPN is up
 *     Android can hand Go a loopback resolver that only answers inside the
 *     tunnel, which would leave the gateway's hostname unresolvable.
 *
 * Traffic counters are not invented here. The config starts Xray's metrics
 * server on loopback and this reads `/debug/vars`, which is the core's own
 * counter for the proxy outbound.
 */
class LibXrayBridge(
    private val protector: SocketProtector,
    private val metricsPort: Int,
) : XrayBridge {

    private val controller = object : DialerController {
        override fun protectFd(fd: Long): Boolean = protector.protect(fd.toInt())
    }

    override fun start(configJson: String) {
        LibXray.registerDialerController(controller)
        LibXray.registerListenerController(controller)
        // Not fatal: with an IP-address gateway the core never asks Go to
        // resolve anything. Worth a log line, not a failed connection.
        runCatching { LibXray.setDNS(controller, DNS_ENDPOINT) }
            .onFailure { Log.w(TAG, "could not point Go's resolver at $DNS_ENDPOINT: ${it.message}") }

        invoke("runXray", JSONObject().put("xrayJson", configJson))
    }

    override fun stop() {
        runCatching { invoke("stopXray", null) }
            .onFailure { Log.w(TAG, "stopXray: ${it.message}") }
        runCatching { LibXray.resetDNS() }
    }

    override fun isRunning(): Boolean =
        runCatching { invoke("getXrayState", null).optBoolean("running") }.getOrDefault(false)

    override fun version(): String? =
        runCatching { invoke("xrayVersion", null).optString("version").takeIf { it.isNotEmpty() } }
            .getOrNull()

    /**
     * Reads the core's own counters.
     *
     * `/debug/vars` answers with
     * `{"stats":{"outbound":{"proxy":{"uplink":N,"downlink":N}}, ...}}`; the
     * proxy outbound is the tunnel, so those two numbers are the session's
     * traffic. Before the first byte moves the keys are absent, which reads as
     * zero rather than as an error.
     */
    override fun trafficStats(): Pair<Long, Long> {
        val body = runCatching {
            val connection = (URL("http://127.0.0.1:$metricsPort/debug/vars").openConnection() as HttpURLConnection)
                .apply { connectTimeout = 1000; readTimeout = 1000 }
            try {
                if (connection.responseCode !in 200..299) return 0L to 0L
                connection.inputStream.bufferedReader().readText()
            } finally {
                connection.disconnect()
            }
        }.getOrElse { return 0L to 0L }

        val proxy = runCatching {
            JSONObject(body).getJSONObject("stats").getJSONObject("outbound").getJSONObject(PROXY_TAG)
        }.getOrElse { return 0L to 0L }

        return proxy.optLong("uplink", 0L) to proxy.optLong("downlink", 0L)
    }

    /**
     * libXray's `pingBatch`: one temporary instance, every configuration tested
     * concurrently through its own outbound.
     *
     * The API accepts at most five configurations per call and rejects the
     * whole batch if given more, so this walks the list in fives. Its error and
     * timeout sentinels (10000 and 11000 ms) are turned back into null: a
     * failure is not a slow success, and nothing downstream should be able to
     * mistake one for the other.
     */
    override fun probe(configs: List<String>, timeoutSeconds: Int): List<Long?> =
        configs.chunked(MAX_PROBE_BATCH).flatMap { batch -> probeBatch(batch, timeoutSeconds) }

    private fun probeBatch(configs: List<String>, timeoutSeconds: Int): List<Long?> {
        val items = JSONArray()
        configs.forEach { config -> items.put(JSONObject().put("xrayJson", config)) }
        val payload = JSONObject()
            .put("configs", items)
            .put("timeout", timeoutSeconds)
            .put("url", PROBE_URL)

        val results = runCatching { invoke("pingBatch", payload).optJSONArray("results") }
            .getOrNull() ?: return configs.map { null }

        return configs.indices.map { index ->
            val result = results.optJSONObject(index) ?: return@map null
            if (!result.optBoolean("success")) return@map null
            val delay = result.optLong("delay", -1L)
            if (delay < 0 || delay >= PROBE_ERROR_DELAY) null else delay
        }
    }

    private fun invoke(method: String, payload: JSONObject?): JSONObject {
        val request = JSONObject()
            .put("apiVersion", API_VERSION)
            .put("method", method)
        if (payload != null) request.put("payload", payload)

        val response = JSONObject(LibXray.invoke(request.toString()))
        if (!response.optBoolean("success")) {
            val message = response.optString("error").ifEmpty { "libXray refused $method" }
            throw IllegalStateException(message)
        }
        return response.optJSONObject("data") ?: JSONObject()
    }

    private companion object {
        const val TAG = "LibXrayBridge"
        const val API_VERSION = 3

        /** Matches the outbound tag XrayConfigBuilder gives the tunnel. */
        const val PROXY_TAG = "proxy"

        /** Must be an IP endpoint with a port, per libXray's SetDNS contract. */
        const val DNS_ENDPOINT = "1.1.1.1:53"

        /** pingBatch refuses a request carrying more than five configurations. */
        const val MAX_PROBE_BATCH = 5

        /** A small, unauthenticated endpoint that answers from everywhere. */
        const val PROBE_URL = "https://cp.cloudflare.com/"

        /** pingBatch reports 10000 for an error and 11000 for a timeout. */
        const val PROBE_ERROR_DELAY = 10_000L
    }
}

fun createXrayBridge(protector: SocketProtector, metricsPort: Int): XrayBridge =
    LibXrayBridge(protector, metricsPort)
