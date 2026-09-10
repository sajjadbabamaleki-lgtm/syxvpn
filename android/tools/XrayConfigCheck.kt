import pro.cvpn.app.core.VlessProfile
import pro.cvpn.app.core.XrayConfigBuilder

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
 *       android/tools/UriStub.kt \
 *       android/app/src/main/java/pro/cvpn/app/core/VlessProfile.kt \
 *       android/app/src/main/java/pro/cvpn/app/core/XrayConfigBuilder.kt \
 *       android/tools/XrayConfigCheck.kt -include-runtime -d /tmp/cfg.jar
 *     java -cp /tmp/cfg.jar:/tmp/json.jar XrayConfigCheckKt > /tmp/xray.json
 *     xray -test -config /tmp/xray.json
 *
 * The TUN inbound, the descriptor in the root `env`, the metrics server and the
 * stats policy are all part of what gets validated.
 */
fun main(args: Array<String>) {
    val uri = args.getOrElse(0) {
        "vless://11111111-2222-3333-4444-555555555555@gw1.example.net:443" +
            "?type=ws&security=tls&path=%2Fws&host=gw1.example.net&sni=gw1.example.net#Frankfurt%20Edge"
    }
    val profile = requireNotNull(VlessProfile.parse(uri)) { "the profile did not parse" }
    check(profile.host == "gw1.example.net") { "host: ${profile.host}" }
    check(profile.port == 443) { "port: ${profile.port}" }
    check(profile.tls) { "tls flag" }
    check(profile.wsPath == "/ws") { "path: ${profile.wsPath}" }
    check(profile.label == "Frankfurt Edge") { "label: ${profile.label}" }

    val json = XrayConfigBuilder.build(
        profile = profile,
        controlPlaneHost = "control.example.net",
        tunFd = 42,
        metricsPort = 49227,
    )
    // The descriptor must reach Xray through the root env, as a string.
    check("\"xray.tun.fd\":\"42\"" in json.replace(" ", "")) { "tun fd missing from env" }

    // The probe config libXray's pingBatch is given: outbounds only, by design.
    val probe = XrayConfigBuilder.outboundOnly(profile)
    check("inbounds" !in probe) { "the probe config must carry no inbound" }
    check("\"protocol\":\"vless\"" in probe.replace(" ", "")) { "the probe config lost its outbound" }
    if (args.getOrNull(1) == "--probe") { print(probe); return }

    print(json)
}
