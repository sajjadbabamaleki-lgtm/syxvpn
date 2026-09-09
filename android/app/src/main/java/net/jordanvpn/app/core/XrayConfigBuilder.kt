package net.jordanvpn.app.core

import org.json.JSONArray
import org.json.JSONObject

/**
 * Builds the Xray client configuration the tunnel runs.
 *
 * The device side is a TUN inbound rather than a SOCKS one. Xray-core carries
 * its own layer-3 stack (`proxy/tun`, gVisor), so the file descriptor from
 * VpnService.Builder.establish() goes straight into the core and no second
 * native component forwards packets. That is not only simpler: libXray embeds a
 * Go runtime, and Go does not support two independently built runtimes in one
 * process, so a Go tun2socks alongside libXray is not an option at all.
 *
 * The fd cannot be written into the TUN settings; Xray reads it from the
 * process environment under `xray.tun.fd`, and the config's root `env` object is
 * applied to the environment while the config is built. That is the documented
 * path for Android in both Xray-core and libXray.
 *
 * The outbound half mirrors what the control plane generates on the gateway:
 * one vless+ws outbound to the selected gateway. Traffic to the control plane
 * and to the gateway itself is routed direct, so a broken tunnel cannot cut the
 * app off from its own API.
 */
object XrayConfigBuilder {

    /** The DNS servers handed to the TUN interface, and to Go's own resolver. */
    val DNS_SERVERS = listOf("1.1.1.1", "8.8.8.8")

    const val TUN_NAME = "jordan0"
    const val MTU = 1500

    /**
     * @param tunFd the descriptor from VpnService, already open in this process.
     * @param metricsPort loopback port for Xray's metrics server; the traffic
     *   counters the connect screen shows are read from it, so they are the
     *   core's own numbers rather than something the app invents.
     */
    /**
     * Just the outbound, for a latency probe.
     *
     * libXray's `pingBatch` reads only the root `outbounds` of what it is
     * given, builds a temporary instance and makes a real request through it.
     * That is the only measurement the phone can make of the *whole* path: a
     * TCP handshake to the gateway proves the first hop and nothing else.
     */
    fun outboundOnly(profile: VlessProfile): String =
        JSONObject().put("outbounds", JSONArray().put(proxyOutbound(profile))).toString()

    fun build(
        profile: VlessProfile,
        controlPlaneHost: String?,
        tunFd: Int,
        metricsPort: Int,
        mtu: Int = MTU,
    ): String = JSONObject()
        .put("log", JSONObject().put("loglevel", "warning"))
        // Applied to the process environment as the config is built; the
        // Android TUN reads the descriptor from here.
        .put("env", JSONObject().put("xray.tun.fd", tunFd.toString()))
        .put("inbounds", JSONArray().put(tunInbound(mtu)))
        .put(
            "outbounds",
            JSONArray()
                .put(proxyOutbound(profile))
                .put(JSONObject().put("tag", "direct").put("protocol", "freedom"))
                .put(JSONObject().put("tag", "block").put("protocol", "blackhole")),
        )
        .put("routing", JSONObject().put("domainStrategy", "AsIs").put("rules", routingRules(profile, controlPlaneHost)))
        // Counters for the connect screen, read over loopback from the metrics
        // server rather than estimated anywhere in the app.
        .put("metrics", JSONObject().put("listen", "127.0.0.1:$metricsPort"))
        .put("stats", JSONObject())
        .put(
            "policy",
            JSONObject().put(
                "system",
                JSONObject()
                    .put("statsOutboundUplink", true)
                    .put("statsOutboundDownlink", true),
            ),
        )
        .toString()

    private fun proxyOutbound(profile: VlessProfile): JSONObject {
        val stream = JSONObject()
            .put("network", "ws")
            .put(
                "wsSettings",
                JSONObject()
                    .put("path", profile.wsPath)
                    // The independent "host" field, not headers.Host: Xray
                    // deprecated the header form and warns about it on every
                    // start.
                    .put("host", profile.wsHost ?: profile.host),
            )
        if (profile.tls) {
            stream.put("security", "tls")
            stream.put(
                "tlsSettings",
                JSONObject()
                    .put("serverName", profile.sni ?: profile.wsHost ?: profile.host)
                    .put("allowInsecure", false),
            )
        }
        val proxy = JSONObject()
            .put("tag", "proxy")
            .put("protocol", "vless")
            .put(
                "settings",
                JSONObject().put(
                    "vnext",
                    JSONArray().put(
                        JSONObject()
                            .put("address", profile.host)
                            .put("port", profile.port)
                            .put(
                                "users",
                                JSONArray().put(
                                    JSONObject()
                                        .put("id", profile.uuid)
                                        .put("encryption", "none")
                                        .put("level", 0),
                                ),
                            ),
                    ),
                ),
            )
            .put("streamSettings", stream)
        return proxy
    }

    private fun routingRules(profile: VlessProfile, controlPlaneHost: String?): JSONArray {
        val rules = JSONArray()
        // The gateway and the control plane stay off the tunnel: if the tunnel
        // breaks, the app must still be able to fetch a new subscription.
        val direct = JSONArray().put(profile.host)
        if (controlPlaneHost != null) direct.put(controlPlaneHost)
        rules.put(
            JSONObject()
                .put("type", "field")
                .put("domain", direct)
                .put("outboundTag", "direct"),
        )
        rules.put(
            JSONObject()
                .put("type", "field")
                .put("ip", JSONArray().put("127.0.0.0/8").put("::1/128"))
                .put("outboundTag", "direct"),
        )
        return rules
    }

    private fun tunInbound(mtu: Int): JSONObject = JSONObject()
        .put("tag", "tun-in")
        // A TUN inbound listens on nothing; the port is required and ignored.
        .put("port", 0)
        .put("protocol", "tun")
        .put(
            "settings",
            JSONObject()
                .put("name", TUN_NAME)
                .put("mtu", mtu),
        )
        .put(
            "sniffing",
            JSONObject()
                .put("enabled", true)
                .put(
                    "destOverride",
                    JSONArray().put("http").put("tls").put("quic"),
                )
                // Sniffing recovers the hostname for routing; it must not
                // rewrite the destination the app asked for.
                .put("routeOnly", true),
        )
}
