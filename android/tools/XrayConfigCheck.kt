import org.json.JSONObject
import pro.syxvpn.app.core.PrivateDns
import pro.syxvpn.app.core.TunnelProfile
import pro.syxvpn.app.core.VlessProfile
import pro.syxvpn.app.core.XrayConfigBuilder

/**
 * Prints the Xray config the app would build, so real Xray-core can judge it.
 *
 * This is not a unit test of the app; it is the answer to "would the core
 * accept what we generate", which is the question that decides whether the
 * tunnel starts at all. Needs only a Kotlin compiler, org.json and an xray
 * binary — no Android SDK:
 *
 *     curl -sSLo /tmp/json.jar \
 *       https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar
 *     kotlinc -cp /tmp/json.jar \
 *       android/app/src/main/java/pro/syxvpn/app/core/UriParts.kt \
 *       android/app/src/main/java/pro/syxvpn/app/core/PrivateDns.kt \
 *       android/app/src/main/java/pro/syxvpn/app/core/VlessProfile.kt \
 *       android/app/src/main/java/pro/syxvpn/app/core/XrayConfigBuilder.kt \
 *       android/tools/XrayConfigCheck.kt -include-runtime -d /tmp/cfg.jar
 *     java -cp /tmp/cfg.jar:/tmp/json.jar XrayConfigCheckKt > /tmp/xray.json
 *     xray -test -config /tmp/xray.json
 *
 * Pass `--dns` for the encrypted-resolver configuration instead, and `--probe`
 * for the outbound-only one libXray's pingBatch is given.
 *
 * The TUN inbound, the descriptor in the root `env`, the metrics server and the
 * stats policy are all part of what gets validated.
 */
fun main(args: Array<String>) {
    val uri = args.getOrElse(0) {
        "vless://11111111-2222-3333-4444-555555555555@gw1.example.net:443" +
            "?type=ws&security=tls&path=%2Fws&host=gw1.example.net&sni=gw1.example.net#Frankfurt%20Edge"
    }
    // Any kind: the point of the tool is what Xray is handed, and the app now
    // hands it vless, shadowsocks or trojan depending on which door is best.
    val profile = requireNotNull(TunnelProfile.parse(uri)) { "the profile did not parse" }
    // Only for the profile this tool ships with. A profile passed in is
    // somebody checking a real one, and asserting the example's values against
    // it turns a working config into a crash.
    if (args.isEmpty()) {
        val vless = profile as VlessProfile
        check(vless.host == "gw1.example.net") { "host: ${vless.host}" }
        check(vless.port == 443) { "port: ${vless.port}" }
        check(vless.tls) { "tls flag" }
        check(vless.wsPath == "/ws") { "path: ${vless.wsPath}" }
        check(vless.label == "Frankfurt Edge") { "label: ${vless.label}" }
    }

    val json = XrayConfigBuilder.build(
        profile = profile,
        controlPlaneHosts = listOf("control.example.net", "control-2.example.net"),
        tunFd = 42,
        metricsPort = 49227,
        appProxyPort = 49228,
    )
    // The descriptor must reach Xray through the root env, as a string.
    check("\"xray.tun.fd\":\"42\"" in json.replace(" ", "")) { "tun fd missing from env" }

    // Nothing about DNS unless a mode asks for it: the default configuration
    // must stay the one that has been running.
    check("dns-out" !in json) { "the standard config grew a DNS outbound" }

    // The encrypted mode: a resolver, an outbound to answer from, and the one
    // rule that sends every port-53 query there. All three or none of them —
    // a rule with no outbound is a config Xray refuses, on a phone.
    val encrypted = XrayConfigBuilder.build(
        profile = profile,
        controlPlaneHosts = listOf("control.example.net"),
        tunFd = 42,
        metricsPort = 49227,
        appProxyPort = 49228,
        dns = PrivateDns.CLOUDFLARE,
    ).replace(" ", "")
    // Read back as JSON rather than matched as text: org.json writes an
    // object's keys in its own order, so a string check here would pass or fail
    // on nothing.
    val parsed = JSONObject(encrypted)
    check(parsed.getJSONObject("dns").getJSONArray("servers").getString(0) == "https://1.1.1.1/dns-query") {
        "no DoH server"
    }
    val outbounds = parsed.getJSONArray("outbounds")
    val dnsOut = (0 until outbounds.length()).map { outbounds.getJSONObject(it) }
        .singleOrNull { it.optString("tag") == "dns-out" }
    check(dnsOut != null && dnsOut.getString("protocol") == "dns") { "no dns outbound" }

    // The app's own door onto the tunnel, and the rule that carries what comes
    // in by it out through the gateway. The rule has to be ahead of the direct
    // ones: they name the control plane, which is exactly what this door is
    // for, and Xray takes the first rule that matches.
    val inbounds = parsed.getJSONArray("inbounds")
    val appIn = (0 until inbounds.length()).map { inbounds.getJSONObject(it) }
        .singleOrNull { it.optString("tag") == "app-in" }
    check(appIn != null) { "no loopback door for the app's own requests" }
    check(appIn!!.getString("listen") == "127.0.0.1") { "the app's door is not on loopback" }
    check(appIn.getInt("port") == 49228) { "the app's door is on the wrong port" }

    val rules = parsed.getJSONObject("routing").getJSONArray("rules")
    val appRuleAt = (0 until rules.length()).singleOrNull {
        rules.getJSONObject(it).optJSONArray("inboundTag")?.optString(0) == "app-in"
    }
    check(appRuleAt != null) { "nothing routes the app's own requests" }
    check(rules.getJSONObject(appRuleAt!!).optString("outboundTag") == "proxy") {
        "the app's own requests are not sent through the gateway"
    }
    check(appRuleAt == 0) { "the direct rules are ahead of the app's own" }
    val dnsRuleAt = (0 until rules.length()).singleOrNull {
        rules.getJSONObject(it).optString("outboundTag") == "dns-out"
    }
    check(dnsRuleAt != null) { "port 53 is not captured" }
    check(rules.getJSONObject(dnsRuleAt!!).optInt("port") == 53) { "the DNS rule is not about port 53" }
    // The control plane is reached without the tunnel, so its rule has to be
    // matched first: its name must not depend on a resolver that only answers
    // while the tunnel is up.
    val directAt = (0 until rules.length()).first {
        rules.getJSONObject(it).optString("outboundTag") == "direct"
    }
    check(directAt < dnsRuleAt) { "the DNS rule is ahead of the direct rules" }
    if (args.getOrNull(1) == "--dns") { print(encrypted); return }

    // A WebSocket gateway's TLS handshake must name a browser. Without it the
    // core sends Go's own, which is the shape a censor matches on.
    val wsProfile = requireNotNull(
        TunnelProfile.parse(
            "vless://11111111-2222-3333-4444-555555555555@edge.example.net:443" +
                "?type=ws&security=tls&path=%2Fws&sni=edge.example.net&fp=chrome#Edge",
        ),
    ) { "the ws profile did not parse" }
    val wsConfig = JSONObject(
        XrayConfigBuilder.build(
            profile = wsProfile,
            controlPlaneHosts = listOf("control.example.net"),
            tunFd = 42,
            metricsPort = 49227,
            appProxyPort = 49228,
        ),
    )
    val wsOut = (0 until wsConfig.getJSONArray("outbounds").length())
        .map { wsConfig.getJSONArray("outbounds").getJSONObject(it) }
        .single { it.optString("tag") == "proxy" }
    val wsTls = wsOut.getJSONObject("streamSettings").getJSONObject("tlsSettings")
    check(wsTls.optString("fingerprint") == "chrome") {
        "the ws outbound's TLS names no browser: ${wsTls}"
    }

    // What the core is told to dial can be an address the app resolved, while
    // every place the name is checked still carries the name.
    val dialled = JSONObject(
        XrayConfigBuilder.build(
            profile = wsProfile,
            controlPlaneHosts = listOf("control.example.net"),
            tunFd = 42,
            metricsPort = 49227,
            appProxyPort = 49228,
            address = "203.0.113.9",
        ),
    )
    val dialledOut = (0 until dialled.getJSONArray("outbounds").length())
        .map { dialled.getJSONArray("outbounds").getJSONObject(it) }
        .single { it.optString("tag") == "proxy" }
    val vnext = dialledOut.getJSONObject("settings").getJSONArray("vnext").getJSONObject(0)
    check(vnext.getString("address") == "203.0.113.9") { "the resolved address was not dialled" }
    check(
        dialledOut.getJSONObject("streamSettings")
            .getJSONObject("tlsSettings").getString("serverName") == "edge.example.net",
    ) { "the certificate would be checked against the address rather than the name" }

    // The probe config libXray's pingBatch is given: outbounds only, by design.
    val probe = XrayConfigBuilder.outboundOnly(profile)
    check("inbounds" !in probe) { "the probe config must carry no inbound" }
    // Whichever protocol this profile turned out to be: the probe has to be
    // able to dial the same door the tunnel would, or it measures nothing.
    val proxy = JSONObject(probe).getJSONArray("outbounds").getJSONObject(0)
    check(proxy.getString("tag") == "proxy") { "the probe config lost its outbound" }
    check(proxy.getString("protocol").isNotEmpty()) { "the probe outbound has no protocol" }
    if (args.getOrNull(1) == "--probe") { print(probe); return }

    print(json)
}
