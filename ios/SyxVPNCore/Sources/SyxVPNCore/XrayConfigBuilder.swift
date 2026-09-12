import Foundation

/// Builds the Xray client configuration the tunnel runs.
///
/// The device side is a TUN inbound rather than a SOCKS one. Xray-core carries
/// its own layer-3 stack (`proxy/tun`, gVisor), so the tunnel's file descriptor
/// goes straight into the core and no second native component forwards packets.
/// That is not only simpler: libXray embeds a Go runtime, and Go does not
/// support two independently built runtimes in one process, so a Go tun2socks
/// alongside libXray is not an option at all.
///
/// The descriptor cannot be written into the TUN settings; Xray reads it from
/// the process environment under `xray.tun.fd`, and the config's root `env`
/// object is applied to the environment while the config is built.
///
/// **One thing here is not yet settled for iOS.** On Android the descriptor
/// comes from `VpnService.Builder.establish()`. NEPacketTunnelProvider hands
/// over a `packetFlow` object instead, and getting a descriptor out of it is
/// not a documented API. That belongs to the tunnel stage, not to this file —
/// what this builds is correct either way, and the key stays `xray.tun.fd`
/// because that is what the core reads.
///
/// The outbound half mirrors what the control plane generates on the gateway.
/// Traffic to the control plane and to the gateway itself is routed direct, so
/// a broken tunnel cannot cut the app off from its own API.
public enum XrayConfigBuilder {

    /// What the TUN interface advertises when no mode says otherwise.
    public static let dnsServers = PrivateDns.standard.addresses

    /// What this build can dial, in the names the subscription endpoint uses.
    ///
    /// It is asked for rather than assumed: the list travels with the request
    /// so a control plane only sends lines this client can turn into a tunnel.
    /// Add an outbound below and add its name here — never the other way round.
    public static let protocols = ["vless", "shadowsocks", "trojan", "reality"]

    public static let tunName = "cvpn0"
    public static let mtu = 1500

    /// Just the outbound, for a latency probe.
    ///
    /// libXray's `pingBatch` reads only the root `outbounds` of what it is
    /// given, builds a temporary instance and makes a real request through it.
    /// That is the only measurement the phone can make of the *whole* path: a
    /// TCP handshake to the gateway proves the first hop and nothing else.
    public static func outboundOnly(_ profile: TunnelProfile) -> String {
        json(["outbounds": [proxyOutbound(profile)]])
    }

    /// The whole configuration, as the dictionary it is built from.
    ///
    /// Exposed beside `build` so the tests can read a field rather than search
    /// a string for it.
    ///
    /// - Parameters:
    ///   - tunFd: the descriptor for the tunnel interface, already open in this
    ///     process.
    ///   - metricsPort: loopback port for Xray's metrics server; the traffic
    ///     counters the connect screen shows are read from it, so they are the
    ///     core's own numbers rather than something the app invents.
    ///   - dns: which resolver the tunnel uses. On an encrypted mode the config
    ///     gains a `dns` section, a `dns` outbound and one routing rule that
    ///     sends every port-53 query to it; the queries are then re-issued as
    ///     DoH, which goes out through the proxy like any other request — so
    ///     they are encrypted to the resolver and invisible to the gateway as
    ///     DNS.
    public static func configuration(
        profile: TunnelProfile,
        controlPlaneHosts: [String],
        tunFd: Int32,
        metricsPort: Int,
        dns: PrivateDns = .standard,
        mtu: Int = XrayConfigBuilder.mtu
    ) -> [String: Any] {
        var outbounds: [[String: Any]] = [
            proxyOutbound(profile),
            ["tag": "direct", "protocol": "freedom"],
            ["tag": "block", "protocol": "blackhole"],
        ]
        // The resolver the tunnel answers with. Present only on an encrypted
        // mode: an outbound nothing routes to would be one more thing in the
        // config that does nothing.
        if dns.encrypted { outbounds.append(["tag": "dns-out", "protocol": "dns"]) }

        var config: [String: Any] = [
            "log": ["loglevel": "warning"],
            // Applied to the process environment as the config is built; the
            // TUN inbound reads the descriptor from here.
            "env": ["xray.tun.fd": String(tunFd)],
            "inbounds": [tunInbound(mtu: mtu)],
            "outbounds": outbounds,
            "routing": [
                "domainStrategy": "AsIs",
                "rules": routingRules(profile: profile, controlPlaneHosts: controlPlaneHosts, dns: dns),
            ],
            // Counters for the connect screen, read over loopback from the
            // metrics server rather than estimated anywhere in the app.
            "metrics": ["listen": "127.0.0.1:\(metricsPort)"],
            "stats": [:] as [String: Any],
            "policy": [
                "system": [
                    "statsOutboundUplink": true,
                    "statsOutboundDownlink": true,
                ],
            ],
        ]
        if let url = dns.dohUrl { config["dns"] = ["servers": [url]] }
        return config
    }

    public static func build(
        profile: TunnelProfile,
        controlPlaneHosts: [String],
        tunFd: Int32,
        metricsPort: Int,
        dns: PrivateDns = .standard,
        mtu: Int = XrayConfigBuilder.mtu
    ) -> String {
        json(configuration(
            profile: profile, controlPlaneHosts: controlPlaneHosts, tunFd: tunFd,
            metricsPort: metricsPort, dns: dns, mtu: mtu
        ))
    }

    /// The outbound for one profile, whatever kind it is.
    ///
    /// One tag, `proxy`, on every kind: the routing rules name it, and they do
    /// not care what is behind it. Adding a protocol is adding a branch here
    /// and changes nothing else in the generated configuration.
    static func proxyOutbound(_ profile: TunnelProfile) -> [String: Any] {
        if let vless = profile as? VlessProfile { return vlessOutbound(vless) }
        if let ss = profile as? ShadowsocksProfile { return shadowsocksOutbound(ss) }
        if let trojan = profile as? TrojanProfile { return trojanOutbound(trojan) }
        // Unreachable while TunnelProfiles.parse is the only door in: it builds
        // one of the three above or nothing. A blackhole rather than a crash,
        // because a tunnel that refuses to start says so on screen and a
        // crashed extension does not.
        return ["tag": "proxy", "protocol": "blackhole"]
    }

    private static func shadowsocksOutbound(_ profile: ShadowsocksProfile) -> [String: Any] {
        [
            "tag": "proxy",
            "protocol": "shadowsocks",
            "settings": [
                "servers": [[
                    "address": profile.host,
                    "port": profile.port,
                    "method": profile.method,
                    // For a 2022 method this is the inbound's key and this
                    // subscriber's, joined — one opaque string here.
                    "password": profile.password,
                    "level": 0,
                ]],
            ],
            // No TLS wrapper: Shadowsocks carries its own encryption over plain
            // TCP, and wrapping it in something else is how a profile stops
            // working.
            "streamSettings": ["network": "tcp"],
        ]
    }

    private static func trojanOutbound(_ profile: TrojanProfile) -> [String: Any] {
        var tls: [String: Any] = [
            "serverName": profile.sni,
            // Never waved past. A trojan gateway that cannot prove its name is
            // either broken or is not the gateway.
            "allowInsecure": false,
        ]
        if let fingerprint = profile.fingerprint { tls["fingerprint"] = fingerprint }
        return [
            "tag": "proxy",
            "protocol": "trojan",
            "settings": [
                "servers": [[
                    "address": profile.host,
                    "port": profile.port,
                    "password": profile.password,
                    "level": 0,
                ]],
            ],
            "streamSettings": [
                "network": "tcp",
                "security": "tls",
                "tlsSettings": tls,
            ],
        ]
    }

    private static func vlessOutbound(_ profile: VlessProfile) -> [String: Any] {
        var stream: [String: Any]
        if let reality = profile.reality {
            // TCP, and the TLS is the borrowed site's. The fingerprint makes
            // the ClientHello look like that browser's, which is the half of
            // the disguise the client is responsible for.
            stream = [
                "network": "tcp",
                "security": "reality",
                "realitySettings": [
                    "serverName": reality.serverName,
                    "publicKey": reality.publicKey,
                    "shortId": reality.shortId,
                    "fingerprint": reality.fingerprint,
                    "show": false,
                ],
            ]
        } else {
            stream = [
                "network": "ws",
                "wsSettings": [
                    "path": profile.wsPath,
                    // The independent "host" field, not headers.Host: Xray
                    // deprecated the header form and warns about it on every
                    // start.
                    "host": profile.wsHost ?? profile.host,
                ],
            ]
            if profile.tls {
                stream["security"] = "tls"
                stream["tlsSettings"] = [
                    "serverName": profile.sni ?? profile.wsHost ?? profile.host,
                    "allowInsecure": false,
                ]
            }
        }

        var user: [String: Any] = [
            "id": profile.uuid,
            "encryption": "none",
            "level": 0,
        ]
        // Vision, and only over REALITY: Xray refuses to start with a flow set
        // on a WebSocket outbound.
        if let reality = profile.reality { user["flow"] = reality.flow }

        return [
            "tag": "proxy",
            "protocol": "vless",
            "settings": [
                "vnext": [[
                    "address": profile.host,
                    "port": profile.port,
                    "users": [user],
                ]],
            ],
            "streamSettings": stream,
        ]
    }

    static func routingRules(
        profile: TunnelProfile, controlPlaneHosts: [String], dns: PrivateDns
    ) -> [[String: Any]] {
        var rules: [[String: Any]] = []
        // The gateway and the control plane stay off the tunnel: if the tunnel
        // breaks, the app must still be able to fetch a new subscription.
        //
        // Every address the app may fall back to, not only the one in use. The
        // fallback exists for the moment the first address stops answering, and
        // if that moment finds the spare routed into a broken tunnel, the app
        // cannot reach the control plane by any road at all.
        var direct = [profile.host]
        direct.append(contentsOf: controlPlaneHosts.filter { !$0.trimmed.isEmpty })
        rules.append(["type": "field", "domain": direct, "outboundTag": "direct"])
        rules.append([
            "type": "field",
            "ip": ["127.0.0.0/8", "::1/128"],
            "outboundTag": "direct",
        ])
        // Every query, whichever resolver an app was told to use and whichever
        // one it asks anyway. A rule that named only the advertised addresses
        // would leave an app with a hard-coded resolver of its own resolving in
        // clear text, which is the leak this is here to close.
        //
        // It comes after the direct rules on purpose: the control plane is
        // reached without the tunnel, and its name must not depend on a
        // resolver that only answers while the tunnel is up.
        if dns.encrypted {
            rules.append(["type": "field", "port": 53, "outboundTag": "dns-out"])
        }
        return rules
    }

    private static func tunInbound(mtu: Int) -> [String: Any] {
        [
            "tag": "tun-in",
            // A TUN inbound listens on nothing; the port is required and ignored.
            "port": 0,
            "protocol": "tun",
            "settings": ["name": tunName, "mtu": mtu],
            "sniffing": [
                "enabled": true,
                "destOverride": ["http", "tls", "quic"],
                // Sniffing recovers the hostname for routing; it must not
                // rewrite the destination the app asked for.
                "routeOnly": true,
            ],
        ]
    }

    /// Sorted keys so the same inputs give the same bytes: a configuration that
    /// changes shape between launches cannot be compared in a log or a test.
    private static func json(_ value: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(
            withJSONObject: value, options: [.sortedKeys]
        ) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}
