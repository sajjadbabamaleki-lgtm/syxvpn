package pro.cvpn.app.vpn

/**
 * The Xray runtime, behind one interface.
 *
 * There is exactly one native piece: libXray, an AAR built from
 * https://github.com/XTLS/libXray with gomobile. There is deliberately no
 * tun2socks. Xray-core carries its own layer-3 stack (`proxy/tun`), so the
 * descriptor from VpnService goes straight into the core — and libXray embeds a
 * Go runtime, which cannot share a process with a second independently built Go
 * runtime, so a Go tun2socks beside it would not even load.
 *
 * Which implementation is compiled is decided by the build, not at runtime:
 * `app/build.gradle.kts` picks `src/xray` when an AAR is present in `app/libs`
 * and `src/noxray` when it is not. Without the AAR the app still builds and
 * still runs; moving the switch then reports that no runtime is bundled instead
 * of pretending to connect. An app that says "connected" without a tunnel is
 * worse than one that says it cannot start.
 */
interface XrayBridge {

    /**
     * Starts the core on [configJson], which already carries the TUN descriptor
     * in its root `env`. Throws with a readable message if the core refuses it.
     */
    fun start(configJson: String)

    fun stop()

    fun isRunning(): Boolean

    /** Cumulative (uplink, downlink) bytes of the current instance. */
    fun trafficStats(): Pair<Long, Long>

    /** The core's version, for the support screen. Null when it cannot be read. */
    fun version(): String?

    /**
     * Measures the round trip *through* each configuration, in milliseconds,
     * null where the request did not complete.
     *
     * This is the only measurement that says anything about the far half of the
     * path: a TCP handshake to a gateway proves the first hop and nothing about
     * whether that gateway can still reach the internet. It builds a temporary
     * instance per configuration, so it can only run while the tunnel is down —
     * the core refuses to build one alongside a running instance.
     */
    fun probe(configs: List<String>, timeoutSeconds: Int = 5): List<Long?>
}

/**
 * Lets the core keep its own sockets out of the tunnel it is serving.
 *
 * Every socket Xray opens — the gateway connection, its DNS lookups — is handed
 * here before it connects, and this calls VpnService.protect(). Without it the
 * gateway connection would be routed into the TUN that is carrying it, which is
 * a loop that simply never passes a packet.
 */
fun interface SocketProtector {
    fun protect(fd: Int): Boolean
}
