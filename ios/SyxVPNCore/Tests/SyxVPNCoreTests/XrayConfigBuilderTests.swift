import XCTest
@testable import SyxVPNCore

/// What this builds becomes the tunnel, so the tests read fields rather than
/// matching strings: a config that is subtly wrong still looks like JSON.
///
/// The Kotlin has no suite here — its builder leans on org.json and was checked
/// by running the app. This one can be checked without a phone, so it is.
final class XrayConfigBuilderTests: XCTestCase {

    private let controlPlane = ["control.syxvpn.pro", "control.example.net"]

    private func vless(_ line: String) throws -> VlessProfile {
        try XCTUnwrap(VlessProfile.parse(line))
    }

    private func outbound(_ config: [String: Any], _ tag: String) throws -> [String: Any] {
        let outbounds = try XCTUnwrap(config["outbounds"] as? [[String: Any]])
        return try XCTUnwrap(outbounds.first { $0["tag"] as? String == tag })
    }

    // MARK: the gateway and the control plane stay off the tunnel

    func testTheGatewayAndEveryControlPlaneAddressAreRoutedDirect() throws {
        let profile = try vless("vless://uuid@gw1.syxvpn.pro:443?type=ws&security=tls")
        let config = XrayConfigBuilder.configuration(
            profile: profile, controlPlaneHosts: controlPlane, tunFd: 7, metricsPort: 9_000
        )
        let routing = try XCTUnwrap(config["routing"] as? [String: Any])
        let rules = try XCTUnwrap(routing["rules"] as? [[String: Any]])
        let domains = try XCTUnwrap(rules.first?["domain"] as? [String])

        XCTAssertEqual(rules.first?["outboundTag"] as? String, "direct")
        XCTAssertTrue(domains.contains("gw1.syxvpn.pro"), "the gateway must not route into itself")
        // Every address it may fall back to, not only the one in use: if the
        // spare is inside a broken tunnel, there is no road to the API at all.
        for host in controlPlane {
            XCTAssertTrue(domains.contains(host), "\(host) is missing from the direct rule")
        }
    }

    func testLoopbackIsDirectToo() throws {
        let profile = try vless("vless://uuid@gw1.syxvpn.pro:443?type=ws")
        let config = XrayConfigBuilder.configuration(
            profile: profile, controlPlaneHosts: [], tunFd: 7, metricsPort: 9_000
        )
        let rules = try XCTUnwrap(
            (config["routing"] as? [String: Any])?["rules"] as? [[String: Any]]
        )
        let loopback = try XCTUnwrap(rules.first { $0["ip"] != nil })
        XCTAssertEqual(loopback["outboundTag"] as? String, "direct")
        XCTAssertEqual(loopback["ip"] as? [String], ["127.0.0.0/8", "::1/128"])
    }

    func testABlankControlPlaneAddressIsNotWrittenIntoTheRule() throws {
        let profile = try vless("vless://uuid@gw1.syxvpn.pro:443?type=ws")
        let config = XrayConfigBuilder.configuration(
            profile: profile, controlPlaneHosts: ["", "   ", "real.example"],
            tunFd: 7, metricsPort: 9_000
        )
        let rules = try XCTUnwrap(
            (config["routing"] as? [String: Any])?["rules"] as? [[String: Any]]
        )
        let domains = try XCTUnwrap(rules.first?["domain"] as? [String])
        XCTAssertEqual(domains, ["gw1.syxvpn.pro", "real.example"])
    }

    // MARK: DNS

    func testAPlainResolverAddsNoDnsSectionOutboundOrRule() throws {
        let profile = try vless("vless://uuid@gw1.syxvpn.pro:443?type=ws")
        let config = XrayConfigBuilder.configuration(
            profile: profile, controlPlaneHosts: controlPlane, tunFd: 7,
            metricsPort: 9_000, dns: .standard
        )
        XCTAssertNil(config["dns"], "a plain mode must generate what shipped before DoH existed")
        let outbounds = try XCTUnwrap(config["outbounds"] as? [[String: Any]])
        XCTAssertFalse(outbounds.contains { $0["tag"] as? String == "dns-out" })
        let rules = try XCTUnwrap(
            (config["routing"] as? [String: Any])?["rules"] as? [[String: Any]]
        )
        XCTAssertFalse(rules.contains { $0["port"] != nil })
    }

    func testAnEncryptedResolverAddsAllThreeAndCatchesEveryPort53Query() throws {
        let profile = try vless("vless://uuid@gw1.syxvpn.pro:443?type=ws")
        let config = XrayConfigBuilder.configuration(
            profile: profile, controlPlaneHosts: controlPlane, tunFd: 7,
            metricsPort: 9_000, dns: .cloudflare
        )
        let dns = try XCTUnwrap(config["dns"] as? [String: Any])
        XCTAssertEqual(dns["servers"] as? [String], ["https://1.1.1.1/dns-query"])
        _ = try outbound(config, "dns-out")

        let rules = try XCTUnwrap(
            (config["routing"] as? [String: Any])?["rules"] as? [[String: Any]]
        )
        let dnsRule = try XCTUnwrap(rules.first { $0["outboundTag"] as? String == "dns-out" })
        // By port, not by the advertised addresses: an app with a resolver of
        // its own hard-coded would otherwise still leak in clear text.
        XCTAssertEqual(dnsRule["port"] as? Int, 53)
        // And after the direct rules, or the control plane's name would depend
        // on a resolver that only answers while the tunnel is up.
        let dnsIndex = try XCTUnwrap(
            rules.firstIndex { $0["outboundTag"] as? String == "dns-out" }
        )
        XCTAssertGreaterThan(dnsIndex, 1)
    }

    // MARK: the three protocols

    func testAWebsocketVlessProfileBecomesAWebsocketOutbound() throws {
        let profile = try vless(
            "vless://11111111-2222-3333-4444-555555555555@gw1.syxvpn.pro:443"
            + "?type=ws&path=%2Fws&host=edge.example&security=tls&sni=edge.example"
        )
        let config = XrayConfigBuilder.configuration(
            profile: profile, controlPlaneHosts: [], tunFd: 7, metricsPort: 9_000
        )
        let proxy = try outbound(config, "proxy")
        XCTAssertEqual(proxy["protocol"] as? String, "vless")

        let stream = try XCTUnwrap(proxy["streamSettings"] as? [String: Any])
        XCTAssertEqual(stream["network"] as? String, "ws")
        XCTAssertEqual(stream["security"] as? String, "tls")
        let ws = try XCTUnwrap(stream["wsSettings"] as? [String: Any])
        XCTAssertEqual(ws["path"] as? String, "/ws")
        // The independent field, not headers.Host, which Xray warns about.
        XCTAssertEqual(ws["host"] as? String, "edge.example")
        XCTAssertNil(ws["headers"])

        let tls = try XCTUnwrap(stream["tlsSettings"] as? [String: Any])
        XCTAssertEqual(tls["serverName"] as? String, "edge.example")
        XCTAssertEqual(tls["allowInsecure"] as? Bool, false)

        let user = try XCTUnwrap(
            ((proxy["settings"] as? [String: Any])?["vnext"] as? [[String: Any]])?
                .first?["users"] as? [[String: Any]]
        ).first
        XCTAssertEqual(user?["id"] as? String, "11111111-2222-3333-4444-555555555555")
        // Vision on a WebSocket outbound makes Xray refuse to start.
        XCTAssertNil(user?["flow"])
    }

    func testARealityProfileCarriesItsKeysAndItsFlow() throws {
        let profile = try vless(
            "vless://uuid@203.0.113.9:443?security=reality&type=tcp&flow=xtls-rprx-vision"
            + "&sni=www.microsoft.com&fp=chrome&pbk=PUBLICKEY&sid=a1b2c3d4"
        )
        let config = XrayConfigBuilder.configuration(
            profile: profile, controlPlaneHosts: [], tunFd: 7, metricsPort: 9_000
        )
        let proxy = try outbound(config, "proxy")
        let stream = try XCTUnwrap(proxy["streamSettings"] as? [String: Any])
        XCTAssertEqual(stream["network"] as? String, "tcp")
        XCTAssertEqual(stream["security"] as? String, "reality")

        let reality = try XCTUnwrap(stream["realitySettings"] as? [String: Any])
        XCTAssertEqual(reality["publicKey"] as? String, "PUBLICKEY")
        XCTAssertEqual(reality["shortId"] as? String, "a1b2c3d4")
        // The borrowed site's name, never the gateway's own address.
        XCTAssertEqual(reality["serverName"] as? String, "www.microsoft.com")
        XCTAssertEqual(reality["fingerprint"] as? String, "chrome")

        let user = try XCTUnwrap(
            ((proxy["settings"] as? [String: Any])?["vnext"] as? [[String: Any]])?
                .first?["users"] as? [[String: Any]]
        ).first
        XCTAssertEqual(user?["flow"] as? String, "xtls-rprx-vision")
        // A REALITY outbound must not also carry a ws TLS block.
        XCTAssertNil(stream["tlsSettings"])
        XCTAssertNil(stream["wsSettings"])
    }

    func testAShadowsocksProfileIsNotWrappedInTls() throws {
        let profile = try XCTUnwrap(
            ShadowsocksProfile.parse("ss://YWVzLTI1Ni1nY206c2VjcmV0@h.example.net:8388#SS")
        )
        let config = XrayConfigBuilder.configuration(
            profile: profile, controlPlaneHosts: [], tunFd: 7, metricsPort: 9_000
        )
        let proxy = try outbound(config, "proxy")
        XCTAssertEqual(proxy["protocol"] as? String, "shadowsocks")
        let stream = try XCTUnwrap(proxy["streamSettings"] as? [String: Any])
        // It carries its own encryption; wrapping it is how a profile stops
        // working.
        XCTAssertEqual(stream["network"] as? String, "tcp")
        XCTAssertNil(stream["security"])

        let server = try XCTUnwrap(
            (proxy["settings"] as? [String: Any])?["servers"] as? [[String: Any]]
        ).first
        XCTAssertEqual(server?["method"] as? String, "aes-256-gcm")
        XCTAssertEqual(server?["password"] as? String, "secret")
        XCTAssertEqual(server?["port"] as? Int, 8388)
    }

    func testATrojanProfileNeverWavesPastACertificate() throws {
        let profile = try XCTUnwrap(
            TrojanProfile.parse("trojan://password@h.example.net:443?sni=h.example.net&fp=chrome")
        )
        let config = XrayConfigBuilder.configuration(
            profile: profile, controlPlaneHosts: [], tunFd: 7, metricsPort: 9_000
        )
        let proxy = try outbound(config, "proxy")
        XCTAssertEqual(proxy["protocol"] as? String, "trojan")
        let tls = try XCTUnwrap(
            (proxy["streamSettings"] as? [String: Any])?["tlsSettings"] as? [String: Any]
        )
        XCTAssertEqual(tls["allowInsecure"] as? Bool, false)
        XCTAssertEqual(tls["serverName"] as? String, "h.example.net")
        XCTAssertEqual(tls["fingerprint"] as? String, "chrome")
    }

    // MARK: the shape the core needs

    func testTheDescriptorIsWhereTheCoreLooksForIt() throws {
        let profile = try vless("vless://uuid@gw1.syxvpn.pro:443?type=ws")
        let config = XrayConfigBuilder.configuration(
            profile: profile, controlPlaneHosts: [], tunFd: 42, metricsPort: 9_000
        )
        let env = try XCTUnwrap(config["env"] as? [String: Any])
        // A string, not a number: it goes into the process environment.
        XCTAssertEqual(env["xray.tun.fd"] as? String, "42")
    }

    func testTheTunInboundSniffsForRoutingWithoutRewritingTheDestination() throws {
        let profile = try vless("vless://uuid@gw1.syxvpn.pro:443?type=ws")
        let config = XrayConfigBuilder.configuration(
            profile: profile, controlPlaneHosts: [], tunFd: 7, metricsPort: 9_000, mtu: 1_400
        )
        let inbound = try XCTUnwrap((config["inbounds"] as? [[String: Any]])?.first)
        XCTAssertEqual(inbound["protocol"] as? String, "tun")
        XCTAssertEqual((inbound["settings"] as? [String: Any])?["mtu"] as? Int, 1_400)
        let sniffing = try XCTUnwrap(inbound["sniffing"] as? [String: Any])
        XCTAssertEqual(sniffing["routeOnly"] as? Bool, true)
    }

    func testTheProbeConfigIsOutboundsAndNothingElse() throws {
        let profile = try vless("vless://uuid@gw1.syxvpn.pro:443?type=ws")
        let text = XrayConfigBuilder.outboundOnly(profile)
        let parsed = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
        )
        XCTAssertEqual(Array(parsed.keys), ["outbounds"])
        XCTAssertEqual((parsed["outbounds"] as? [[String: Any]])?.count, 1)
    }

    func testTheSameInputsGiveTheSameBytes() throws {
        let profile = try vless("vless://uuid@gw1.syxvpn.pro:443?type=ws&security=tls")
        let once = XrayConfigBuilder.build(
            profile: profile, controlPlaneHosts: controlPlane, tunFd: 7, metricsPort: 9_000
        )
        let twice = XrayConfigBuilder.build(
            profile: profile, controlPlaneHosts: controlPlane, tunFd: 7, metricsPort: 9_000
        )
        XCTAssertEqual(once, twice, "a config that changes shape cannot be diffed in a log")
        XCTAssertFalse(once.isEmpty)
    }

    func testEveryProtocolTheClientAdvertisesHasAnOutboundBehindIt() {
        // The list travels with the subscription request, so a name here that
        // the builder cannot produce means the control plane sends lines this
        // client will refuse.
        XCTAssertEqual(
            Set(XrayConfigBuilder.protocols),
            ["vless", "shadowsocks", "trojan", "reality"]
        )
    }
}
