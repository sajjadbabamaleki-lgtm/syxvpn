package net.jordanvpn.app.vpn

import android.os.ParcelFileDescriptor

/**
 * The two native pieces this app needs, kept behind one interface.
 *
 * NOTHING IN THIS REPOSITORY IMPLEMENTS THIS YET. Wiring it up means adding:
 *
 *  1. libXray (https://github.com/XTLS/libXray) built as an AAR with gomobile,
 *     which runs the Xray instance from the JSON in XrayConfigBuilder.
 *  2. a TUN-to-SOCKS forwarder — hev-socks5-tunnel or tun2socks — which takes
 *     the file descriptor from VpnService.Builder.establish() and forwards the
 *     packets into Xray's local SOCKS inbound.
 *
 * Until both are present, [NotWiredXrayBridge] fails loudly rather than
 * pretending to connect: an app that says "connected" without a tunnel is worse
 * than one that says it cannot start.
 */
interface XrayBridge {
    fun start(configJson: String, tun: ParcelFileDescriptor, socksPort: Int)
    fun stop()
    fun isRunning(): Boolean
    /** Cumulative bytes since start, for the traffic counters. */
    fun trafficStats(): Pair<Long, Long>
}

class NotWiredXrayBridge : XrayBridge {
    override fun start(configJson: String, tun: ParcelFileDescriptor, socksPort: Int) {
        throw IllegalStateException(
            "No Xray runtime bundled. See android/README.md: add the libXray AAR and a " +
                "tun2socks implementation, then replace NotWiredXrayBridge.",
        )
    }

    override fun stop() = Unit
    override fun isRunning() = false
    override fun trafficStats() = 0L to 0L
}
