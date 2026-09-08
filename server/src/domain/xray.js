/**
 * Xray data-plane generation.
 *
 * Two artefacts are produced here:
 *  1. Client profiles (`vless://…`) — the FIRST HOP only. A profile says how a
 *     client reaches a gateway; it says nothing about how that gateway reaches
 *     the internet.
 *  2. Gateway server configuration — inbound, the outbound set built from the
 *     egress paths assigned to that gateway, and the routing rules that select
 *     the currently active egress.
 *
 * Nothing in the client profile is derived from egress credentials; egress
 * secrets never leave the control plane except towards an authenticated agent.
 */

export const API_PORT = 10085;

// Routed to the blackhole so a gateway cannot be used to reach its own LAN,
// the control plane, or link-local metadata services.
const PRIVATE_RANGES = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.168.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10',
];

/** Public port a client dials, and the transport security it must use. */
export function clientEndpoint(gateway) {
  const tls = gateway.tls_mode === 'reverse-proxy' || gateway.tls_mode === 'xray';
  return { host: gateway.host, port: gateway.port, tls };
}

/** Address/port the Xray process itself binds on the gateway host. */
export function listenEndpoint(gateway) {
  if (gateway.tls_mode === 'reverse-proxy') {
    // TLS is terminated by the reverse proxy; Xray listens on loopback only.
    return { address: gateway.listen_address || '127.0.0.1', port: gateway.listen_port || gateway.port };
  }
  return { address: gateway.listen_address || '0.0.0.0', port: gateway.listen_port || gateway.port };
}

/**
 * Builds a `vless://` profile for one gateway/credential pair.
 * `security=tls` is only emitted when the gateway actually terminates TLS
 * (directly in Xray, or in front of it via a reverse proxy).
 */
export function clientProfile(gateway, credentialUuid, labelSuffix = '') {
  const { host, port, tls } = clientEndpoint(gateway);
  const params = new URLSearchParams({
    encryption: 'none',
    type: 'ws',
    path: gateway.ws_path || '/ws',
    host: gateway.ws_host || gateway.sni || host,
  });
  params.set('security', tls ? 'tls' : 'none');
  if (tls) {
    params.set('sni', gateway.sni || gateway.ws_host || host);
    params.set('fp', 'chrome');
  }
  const label = `${gateway.name} · ${gateway.region}${labelSuffix}`;
  return `vless://${credentialUuid}@${host}:${port}?${params.toString()}#${encodeURIComponent(label)}`;
}

/** Xray outbound for one egress definition. Tag is stable: `egress-<id>`. */
export function egressOutbound(egress) {
  const tag = egressTag(egress.id);
  switch (egress.kind) {
    case 'direct': {
      const outbound = {
        tag,
        protocol: 'freedom',
        settings: { domainStrategy: 'UseIPv4' },
      };
      // Selects which authorized uplink/source address the gateway leaves from.
      if (egress.bind_address) outbound.sendThrough = egress.bind_address;
      return outbound;
    }
    case 'socks': {
      const server = { address: egress.host, port: egress.port };
      if (egress.username) server.users = [{ user: egress.username, pass: egress.secret || '' }];
      return { tag, protocol: 'socks', settings: { servers: [server] } };
    }
    case 'vless': {
      const streamSettings = { network: egress.transport === 'ws' ? 'ws' : 'tcp' };
      if (egress.transport === 'ws') {
        streamSettings.wsSettings = { path: egress.ws_path || '/ws' };
        if (egress.sni) streamSettings.wsSettings.headers = { Host: egress.sni };
      }
      if (egress.tls) {
        streamSettings.security = 'tls';
        streamSettings.tlsSettings = { serverName: egress.sni || egress.host };
      }
      return {
        tag,
        protocol: 'vless',
        settings: {
          vnext: [{
            address: egress.host,
            port: egress.port,
            users: [{ id: egress.secret, encryption: 'none', level: 0 }],
          }],
        },
        streamSettings,
      };
    }
    default:
      throw new Error(`unsupported egress kind: ${egress.kind}`);
  }
}

export const egressTag = (id) => `egress-${id}`;

/**
 * Full Xray server configuration for a gateway.
 *
 * @param {object} gateway
 * @param {Array<{credentialId:string, uuid:string}>} clients currently entitled credentials
 * @param {Array<object>} egresses egress paths assigned to this gateway
 * @param {string|null} activeEgressId the egress selected by the control plane
 */
export function gatewayServerConfig(gateway, clients, egresses, activeEgressId) {
  const listen = listenEndpoint(gateway);
  const inbound = {
    tag: 'client-in',
    listen: listen.address,
    port: listen.port,
    protocol: 'vless',
    settings: {
      clients: clients.map((c) => ({ id: c.uuid, email: c.credentialId, level: 0 })),
      decryption: 'none',
    },
    streamSettings: {
      network: 'ws',
      wsSettings: {
        path: gateway.ws_path || '/ws',
        ...(gateway.ws_host ? { headers: { Host: gateway.ws_host } } : {}),
      },
    },
    sniffing: { enabled: true, destOverride: ['http', 'tls'] },
  };

  if (gateway.tls_mode === 'xray') {
    // Only emitted when real certificate material has been configured; the
    // control plane rejects tls_mode=xray without cert and key paths.
    inbound.streamSettings.security = 'tls';
    inbound.streamSettings.tlsSettings = {
      serverName: gateway.sni || gateway.host,
      alpn: ['http/1.1'],
      certificates: [{ certificateFile: gateway.tls_cert_path, keyFile: gateway.tls_key_path }],
    };
  }

  const assigned = egresses.filter((e) => e.enabled);
  const active = assigned.find((e) => e.id === activeEgressId) || null;
  const ordered = active ? [active, ...assigned.filter((e) => e.id !== active.id)] : assigned;

  const outbounds = ordered.map(egressOutbound);
  outbounds.push({ tag: 'block', protocol: 'blackhole', settings: { response: { type: 'none' } } });

  const rules = [{ type: 'field', inboundTag: ['api-in'], outboundTag: 'api' }];
  // Disabled only for lab gateways whose test targets live on private ranges.
  if (gateway.block_private_ranges !== 0) {
    rules.push({ type: 'field', ip: PRIVATE_RANGES, outboundTag: 'block' });
  }
  rules.push({ type: 'field', protocol: ['bittorrent'], outboundTag: 'block' });
  if (active) {
    rules.push({ type: 'field', network: 'tcp,udp', outboundTag: egressTag(active.id) });
  }

  return {
    log: { loglevel: 'warning' },
    // Per-user counters are the source of truth for quota accounting.
    api: { tag: 'api', services: ['HandlerService', 'StatsService'] },
    stats: {},
    policy: {
      levels: { 0: { statsUserUplink: true, statsUserDownlink: true, handshake: 4, connIdle: 300 } },
      system: { statsInboundUplink: true, statsInboundDownlink: true },
    },
    inbounds: [
      inbound,
      {
        tag: 'api-in',
        listen: '127.0.0.1',
        port: API_PORT,
        protocol: 'dokodemo-door',
        settings: { address: '127.0.0.1' },
      },
    ],
    outbounds: outbounds.length > 1 ? outbounds : [
      // No usable egress assigned: fail closed rather than silently sending
      // subscriber traffic out of the gateway's own default route.
      { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'none' } } },
    ],
    routing: { domainStrategy: 'AsIs', rules },
  };
}

/**
 * Deterministic content hash of a generated config, used by the agent to decide
 * whether a redeploy is actually needed.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
