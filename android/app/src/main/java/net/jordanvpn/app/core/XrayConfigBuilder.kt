package net.jordanvpn.app.core

import org.json.JSONArray
import org.json.JSONObject

/**
 * Builds the Xray client configuration the tunnel runs.
 *
 * The shape mirrors what the control plane generates on the gateway side: one
 * inbound the device feeds, one outbound to the selected gateway. Traffic to
 * the control plane itself is excluded so a broken tunnel cannot cut the app
 * off from its own API.
 */
object XrayConfigBuilder {

    const val SOCKS_PORT = 10808

    fun build(profile: VlessProfile, controlPlaneHost: String?): String {
        val stream = JSONObject()
            .put("network", "ws")
            .put(
                "wsSettings",
                JSONObject()
                    .put("path", profile.wsPath)
                    .put("headers", JSONObject().put("Host", profile.wsHost ?: profile.host)),
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

        val rules = JSONArray()
        // Keep the control plane and the gateway itself off the tunnel.
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

        return JSONObject()
            .put("log", JSONObject().put("loglevel", "warning"))
            .put(
                "inbounds",
                JSONArray().put(
                    JSONObject()
                        .put("tag", "socks-in")
                        .put("listen", "127.0.0.1")
                        .put("port", SOCKS_PORT)
                        .put("protocol", "socks")
                        .put("settings", JSONObject().put("auth", "noauth").put("udp", true))
                        .put(
                            "sniffing",
                            JSONObject()
                                .put("enabled", true)
                                .put("destOverride", JSONArray().put("http").put("tls")),
                        ),
                ),
            )
            .put(
                "outbounds",
                JSONArray()
                    .put(proxy)
                    .put(JSONObject().put("tag", "direct").put("protocol", "freedom"))
                    .put(JSONObject().put("tag", "block").put("protocol", "blackhole")),
            )
            .put("routing", JSONObject().put("domainStrategy", "AsIs").put("rules", rules))
            .toString()
    }
}
