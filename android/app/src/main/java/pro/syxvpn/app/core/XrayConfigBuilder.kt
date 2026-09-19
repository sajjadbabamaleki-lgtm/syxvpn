package pro.syxvpn.app.core

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

    /**
     * What the TUN interface advertises when no mode says otherwise.
     *
     * [PrivateDns.STANDARD] carries the same two addresses, so a build with the
     * private-DNS flag off generates what the app has always generated.
     */
    val DNS_SERVERS = PrivateDns.STANDARD.addresses

    /**
     * What this build can dial, in the names the subscription endpoint uses.
     *
     * It is asked for rather than assumed: the list travels with the request so
     * a control plane only sends lines this client can turn into a tunnel. Add
     * an outbound below and add its name here — never the other way round.
     */
    val PROTOCOLS = listOf("vless", "shadowsocks", "trojan", "reality")

    const val TUN_NAME = "cvpn0"
    const val MTU = 1500

    /** The loopback door the app's own control-plane requests come in by. */
    private const val APP_INBOUND = "app-in"

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
    fun outboundOnly(profile: TunnelProfile): String =
        JSONObject().put("outbounds", JSONArray().put(proxyOutbound(profile))).toString()

    /**
     * @param dns which resolver the tunnel uses. On an encrypted mode the
     *   config gains a `dns` section, a `dns` outbound and one routing rule
     *   that sends every port-53 query to it; the queries are then re-issued as
     *   DoH, which goes out through the proxy like any other request — so they
     *   are encrypted to the resolver and invisible to the gateway as DNS.
     */
    fun build(
        profile: TunnelProfile,
        controlPlaneHosts: List<String>,
        tunFd: Int,
        metricsPort: Int,
        appProxyPort: Int,
        dns: PrivateDns = PrivateDns.STANDARD,
        mtu: Int = MTU,
    ): String = JSONObject()
        .put("log", JSONObject().put("loglevel", "warning"))
        // Applied to the process environment as the config is built; the
        // Android TUN reads the descriptor from here.
        .put("env", JSONObject().put("xray.tun.fd", tunFd.toString()))
        .put("inbounds", JSONArray().put(tunInbound(mtu)).put(appInbound(appProxyPort)))
        .put(
            "outbounds",
            JSONArray()
                .put(proxyOutbound(profile))
                .put(JSONObject().put("tag", "direct").put("protocol", "freedom"))
                .put(JSONObject().put("tag", "block").put("protocol", "blackhole"))
                // The resolver the tunnel answers with. Present only on an
                // encrypted mode: an outbound nothing routes to would be one
                // more thing in the config that does nothing.
                .apply {
                    if (dns.encrypted) put(JSONObject().put("tag", "dns-out").put("protocol", "dns"))
                },
        )
        .apply {
            dns.dohUrl?.let { url ->
                put("dns", JSONObject().put("servers", JSONArray().put(url)))
            }
        }
        .put("routing", JSONObject().put("domainStrategy", "AsIs").put("rules", routingRules(profile, controlPlaneHosts, dns)))
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

    /**
     * The outbound for one profile, whatever kind it is.
     *
     * One tag, `proxy`, on every kind: the routing rules name it, and they do
     * not care what is behind it. Adding a protocol is adding a branch here and
     * changes nothing else in the generated configuration.
     */
    private fun proxyOutbound(profile: TunnelProfile): JSONObject = when (profile) {
        is VlessProfile -> vlessOutbound(profile)
        is ShadowsocksProfile -> shadowsocksOutbound(profile)
        is TrojanProfile -> trojanOutbound(profile)
    }

    private fun shadowsocksOutbound(profile: ShadowsocksProfile): JSONObject = JSONObject()
        .put("tag", "proxy")
        .put("protocol", "shadowsocks")
        .put(
            "settings",
            JSONObject().put(
                "servers",
                JSONArray().put(
                    JSONObject()
                        .put("address", profile.host)
                        .put("port", profile.port)
                        .put("method", profile.method)
                        // For a 2022 method this is the inbound's key and this
                        // subscriber's, joined — one opaque string here.
                        .put("password", profile.password)
                        .put("level", 0),
                ),
            ),
        )
        // No streamSettings: Shadowsocks carries its own encryption over plain
        // TCP, and wrapping it in something else is how a profile stops working.
        .put("streamSettings", JSONObject().put("network", "tcp"))

    private fun trojanOutbound(profile: TrojanProfile): JSONObject {
        val tls = JSONObject()
            .put("serverName", profile.sni)
            // Never waved past. A trojan gateway that cannot prove its name is
            // either broken or is not the gateway.
            .put("allowInsecure", false)
        profile.fingerprint?.let { tls.put("fingerprint", it) }
        return JSONObject()
            .put("tag", "proxy")
            .put("protocol", "trojan")
            .put(
                "settings",
                JSONObject().put(
                    "servers",
                    JSONArray().put(
                        JSONObject()
                            .put("address", profile.host)
                            .put("port", profile.port)
                            .put("password", profile.password)
                            .put("level", 0),
                    ),
                ),
            )
            .put(
                "streamSettings",
                JSONObject()
                    .put("network", "tcp")
                    .put("security", "tls")
                    .put("tlsSettings", tls),
            )
    }

    private fun vlessOutbound(profile: VlessProfile): JSONObject {
        val reality = profile.reality
        val stream = if (reality != null) {
            // TCP, and the TLS is the borrowed site's. The fingerprint makes
            // the ClientHello look like that browser's, which is the half of
            // the disguise the client is responsible for.
            JSONObject()
                .put("network", "tcp")
                .put("security", "reality")
                .put(
                    "realitySettings",
                    JSONObject()
                        .put("serverName", reality.serverName)
                        .put("publicKey", reality.publicKey)
                        .put("shortId", reality.shortId)
                        .put("fingerprint", reality.fingerprint)
                        .put("show", false),
                )
        } else {
            JSONObject()
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
        }
        if (reality == null && profile.tls) {
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
                                        .put("level", 0)
                                        // Vision, and only over REALITY: Xray
                                        // refuses to start with a flow set on
                                        // a WebSocket outbound.
                                        .apply { profile.reality?.let { put("flow", it.flow) } },
                                ),
                            ),
                    ),
                ),
            )
            .put("streamSettings", stream)
        return proxy
    }

    private fun routingRules(
        profile: TunnelProfile,
        controlPlaneHosts: List<String>,
        dns: PrivateDns,
    ): JSONArray {
        val rules = JSONArray()
        // What the app hands to the loopback door goes out through the gateway,
        // and this rule is first because the one below it names the same hosts.
        //
        // The app is excluded from the TUN and reaches the control plane on its
        // own; this door is the other road, and it exists for the case that
        // road is closed — a control-plane name filtered where the phone sits.
        // Sending it back out "direct" would be sending it back into the block.
        rules.put(
            JSONObject()
                .put("type", "field")
                .put("inboundTag", JSONArray().put(APP_INBOUND))
                .put("outboundTag", "proxy"),
        )
        // The gateway and the control plane stay off the tunnel: if the tunnel
        // breaks, the app must still be able to fetch a new subscription.
        //
        // Every address the app may fall back to, not only the one in use. The
        // fallback exists for the moment the first address stops answering, and
        // if that moment finds the spare routed into a broken tunnel, the app
        // cannot reach the control plane by any road at all.
        val direct = JSONArray().put(profile.host)
        controlPlaneHosts.filter { it.isNotBlank() }.forEach { direct.put(it) }
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
        // Every query, whichever resolver an app was told to use and whichever
        // one it asks anyway. A rule that named only the advertised addresses
        // would leave an app with a hard-coded resolver of its own resolving in
        // clear text, which is the leak this is here to close.
        //
        // It comes after the direct rules on purpose: the control plane is
        // reached without the tunnel, and its name must not depend on a
        // resolver that only answers while the tunnel is up.
        if (dns.encrypted) {
            rules.put(
                JSONObject()
                    .put("type", "field")
                    .put("port", 53)
                    .put("outboundTag", "dns-out"),
            )
        }
        return rules
    }

    /**
     * A SOCKS door on loopback for this app's own requests.
     *
     * Bound to 127.0.0.1, so nothing off the phone can reach it, and no
     * authentication for the same reason. Names are resolved at the far end
     * rather than here: what the app sends through it is a hostname, which is
     * the point, since the resolver on this side may be the thing lying about
     * it.
     */
    private fun appInbound(port: Int): JSONObject = JSONObject()
        .put("tag", APP_INBOUND)
        .put("listen", "127.0.0.1")
        .put("port", port)
        .put("protocol", "socks")
        .put(
            "settings",
            JSONObject()
                .put("auth", "noauth")
                // TCP only: this carries HTTPS requests and nothing else.
                .put("udp", false),
        )

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
