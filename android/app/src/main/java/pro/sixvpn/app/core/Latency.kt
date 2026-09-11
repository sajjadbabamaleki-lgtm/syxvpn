package pro.sixvpn.app.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Measures how long a TCP handshake to the gateway takes.
 *
 * This is the same thing the control plane measures from its own vantage point,
 * but from the phone's — which is the number that matters to the person holding
 * it. It is a real measurement: a failure returns null rather than a placeholder.
 */
object Latency {
    suspend fun measure(host: String, port: Int, timeoutMs: Int = 4000): Long? =
        withContext(Dispatchers.IO) {
            val started = System.nanoTime()
            runCatching {
                Socket().use { socket ->
                    socket.connect(InetSocketAddress(host, port), timeoutMs)
                }
            }.map { (System.nanoTime() - started) / 1_000_000 }.getOrNull()
        }
}
