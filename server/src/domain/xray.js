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

import { splitList } from '../lib/reality.js';
import { inboundConfig } from './inbounds.js';

export const API_PORT = 10085;
// Loopback SOCKS inbounds, one per assigned egress, used by the gateway agent
// to measure each egress path end to end *through the real data plane*.
export const PROBE_PORT_BASE = 10800;

export const probePort = (index) => PROBE_PORT_BASE + index;

// Routed to the blackhole so a gateway cannot be used to reach its own LAN,
// the control plane, or link-local metadata services.
const PRIVATE_RANGES = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.168.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10',
];

/**
 * Does this gateway speak REALITY?
 *
 * It changes almost everything about the shape of a profile and an inbound —
 * TCP rather than WebSocket, a borrowed handshake rather than a certificate,
 * no reverse proxy in front — so it is asked once, by name, everywhere.
 */
export const isReality = (gateway) => gateway.transport === 'reality';

/** Public port a client dials, and the transport security it must use. */
export function clientEndpoint(gateway) {
  const tls = gateway.tls_mode === 'reverse-proxy' || gateway.tls_mode === 'xray';
  // REALITY carries its own TLS, which is the point of it: there is no
  // certificate and no proxy in front, so tls_mode says nothing here.
  return { host: gateway.host, port: gateway.port, tls: isReality(gateway) ? false : tls };
}

export const realityServerNames = (gateway) => splitList(gateway.reality_server_names);
export const realityShortIds = (gateway) => splitList(gateway.reality_short_ids);

/** Address/port the Xray process itself binds on the gateway host. */
export function listenEndpoint(gateway) {
  // A REALITY gateway is the public listener: nothing can sit in front of it,
  // because the handshake it forwards has to come from the real socket.
  if (!isReality(gateway) && gateway.tls_mode === 'reverse-proxy') {
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
  const label = `${gateway.name} · ${gateway.region}${labelSuffix}`;
  if (isReality(gateway)) {
    const names = realityServerNames(gateway);
    const shortIds = realityShortIds(gateway);
    const params = new URLSearchParams({
      encryption: 'none',
      security: 'reality',
      type: 'tcp',
      // Vision is what makes a REALITY connection's packet sizes look like a
      // browser's rather than a proxy's; without it the disguise is only skin
      // deep. Every client that can do REALITY can do Vision.
      flow: 'xtls-rprx-vision',
      // The name the client claims in its handshake. It has to be one the
      // borrowed site actually serves, which is what serverNames lists.
      sni: names[0] || gateway.sni || gateway.host,
      fp: gateway.reality_fingerprint || 'chrome',
      pbk: gateway.reality_public_key || '',
    });
    // Optional: an empty short ID means "any client with the public key".
    if (shortIds[0]) params.set('sid', shortIds[0]);
    return `vless://${credentialUuid}@${gateway.host}:${gateway.port}?${params.toString()}#${encodeURIComponent(label)}`;
  }
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
export const probeTag = (id) => `probe-${id}`;

/**
 * Full Xray server configuration for a gateway.
 *
 * @param {object} gateway
 * @param {Array<{credentialId:string, uuid:string}>} clients currently entitled credentials
 * @param {Array<object>} egresses egress paths assigned to this gateway
 * @param {string|null} activeEgressId the egress selected by the control plane
 * @param {Array<object>} extraInbounds additional doors into the same gateway
 *   (see domain/inbounds.js). Empty is the shape this function had before they
 *   existed, and is what a fleet with the feature off keeps generating.
 */
export function gatewayServerConfig(gateway, clients, egresses, activeEgressId, extraInbounds = []) {
  const listen = listenEndpoint(gateway);
  const reality = isReality(gateway);
  const inbound = {
    tag: 'client-in',
    listen: listen.address,
    port: listen.port,
    protocol: 'vless',
    settings: {
      clients: clients.map((c) => ({
        id: c.uuid,
        email: c.credentialId,
        level: 0,
        // Vision only exists over TCP+REALITY here; a WebSocket inbound would
        // refuse to start with a flow set on its clients.
        ...(reality ? { flow: 'xtls-rprx-vision' } : {}),
      })),
      decryption: 'none',
    },
    streamSettings: reality
      ? {
        network: 'tcp',
        security: 'reality',
        realitySettings: {
          show: false,
          // The site whose handshake is borrowed. Anyone who is not a
          // subscriber — a censor's prober included — is forwarded here and
          // gets that site's genuine TLS, from that site's own certificate.
          dest: gateway.reality_dest,
          xver: 0,
          serverNames: realityServerNames(gateway),
          privateKey: gateway.reality_private_key,
          shortIds: realityShortIds(gateway),
        },
      }
      : {
        network: 'ws',
        wsSettings: {
          path: gateway.ws_path || '/ws',
          ...(gateway.ws_host ? { headers: { Host: gateway.ws_host } } : {}),
        },
      },
    sniffing: { enabled: true, destOverride: ['http', 'tls'] },
  };

  if (!reality && gateway.tls_mode === 'xray') {
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

  const blackhole = { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'none' } } };
  // Xray treats the first outbound as the default. With no usable egress the
  // blackhole goes first so subscriber traffic fails closed instead of leaking
  // out of the gateway's own default route.
  const outbounds = active
    ? [...ordered.map(egressOutbound), blackhole]
    : [blackhole, ...ordered.map(egressOutbound)];

  // Probe inbounds: one loopback SOCKS listener per egress, pinned by a routing
  // rule to that egress only. The agent measures each path through them.
  const probeInbounds = ordered.map((e, index) => ({
    tag: probeTag(e.id),
    listen: '127.0.0.1',
    port: probePort(index),
    protocol: 'socks',
    settings: { auth: 'noauth', udp: false },
  }));

  const extra = extraInbounds.map((inbound) => inboundConfig(gateway, inbound, clients));
  // Every door into this gateway, for the rules that have to name all of them.
  const clientTags = ['client-in', ...extra.map((i) => i.tag)];

  const rules = [{ type: 'field', inboundTag: ['api-in'], outboundTag: 'api' }];
  for (const e of ordered) {
    rules.push({ type: 'field', inboundTag: [probeTag(e.id)], outboundTag: egressTag(e.id) });
  }
  // Disabled only for lab gateways whose test targets live on private ranges.
  if (gateway.block_private_ranges !== 0) {
    rules.push({ type: 'field', ip: PRIVATE_RANGES, outboundTag: 'block' });
  }
  rules.push({ type: 'field', protocol: ['bittorrent'], outboundTag: 'block' });
  if (active) {
    rules.push({ type: 'field', network: 'tcp,udp', outboundTag: egressTag(active.id) });
  } else {
    // Probe inbounds are matched earlier, so the agent can still measure every
    // path and the gateway can recover automatically once one comes back.
    rules.push({ type: 'field', inboundTag: clientTags, outboundTag: 'block' });
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
      ...extra,
      ...probeInbounds,
      {
        tag: 'api-in',
        listen: '127.0.0.1',
        port: API_PORT,
        protocol: 'dokodemo-door',
        settings: { address: '127.0.0.1' },
      },
    ],
    outbounds,
    routing: { domainStrategy: 'AsIs', rules },
  };
}

/**
 * The part of a configuration that cannot change without restarting Xray.
 *
 * Adding or removing a subscriber only changes the client list, and Xray can
 * apply that live through its API. Splitting the two lets an agent tell the
 * difference: issuing a batch of subscriptions should not drop every existing
 * connection on the gateway.
 */
export function structuralConfig(config) {
  const inbounds = config.inbounds.map((inbound) => {
    // Every client-carrying door, not only the gateway's own: an additional
    // inbound holds the same client list, and leaving it in here would turn
    // every subscriber added or removed into a full redeploy of the fleet.
    if (!String(inbound.tag || '').startsWith('client-in')) return inbound;
    const { settings, ...rest } = inbound;
    const { clients, ...restSettings } = settings || {};
    return { ...rest, settings: { ...restSettings, clients: [] } };
  });
  return { ...config, inbounds };
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
