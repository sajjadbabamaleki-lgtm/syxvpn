import test from 'node:test';
import assert from 'node:assert/strict';
import { clientProfile, gatewayServerConfig, listenEndpoint, egressOutbound, API_PORT } from '../src/domain/xray.js';

const gateway = (overrides = {}) => ({
  id: 'gw_test', name: 'Edge A', region: 'tehran', host: 'edge.example.net', port: 443,
  tls_mode: 'none', ws_path: '/ws', ws_host: null, sni: null,
  listen_address: '0.0.0.0', listen_port: null, block_private_ranges: 1, ...overrides,
});
const clients = [{ credentialId: 'cr_one', uuid: '11111111-2222-3333-4444-555555555555' }];

test('client profile generation', async (t) => {
  await t.test('emits security=none when nothing terminates TLS', () => {
    const uri = clientProfile(gateway(), clients[0].uuid);
    assert.match(uri, /^vless:\/\/11111111-2222-3333-4444-555555555555@edge\.example\.net:443\?/);
    assert.match(uri, /security=none/);
    assert.ok(!uri.includes('sni='));
  });

  await t.test('emits security=tls only when TLS is really terminated', () => {
    const proxied = clientProfile(gateway({ tls_mode: 'reverse-proxy', sni: 'edge.example.net', listen_port: 10001 }), clients[0].uuid);
    assert.match(proxied, /security=tls/);
    assert.match(proxied, /sni=edge\.example\.net/);

    const direct = clientProfile(gateway({ tls_mode: 'xray', tls_cert_path: '/c.pem', tls_key_path: '/k.pem' }), clients[0].uuid);
    assert.match(direct, /security=tls/);
  });

  await t.test('carries the websocket host and path', () => {
    const uri = clientProfile(gateway({ ws_path: '/jordan-ws', ws_host: 'cdn.example.net' }), clients[0].uuid);
    const params = new URL(uri).searchParams;
    assert.equal(params.get('path'), '/jordan-ws');
    assert.equal(params.get('host'), 'cdn.example.net');
    assert.equal(params.get('type'), 'ws');
    // The Host header is an HTTP-layer value; the TCP destination is unchanged.
    assert.equal(new URL(uri).hostname, 'edge.example.net');
  });
});

test('gateway server configuration', async (t) => {
  const egresses = [
    { id: 'eg_socks', kind: 'socks', host: '10.9.0.2', port: 1080, username: 'u', secret: 'p', enabled: 1, priority: 10 },
    { id: 'eg_direct', kind: 'direct', bind_address: '203.0.113.9', enabled: 1, priority: 20 },
  ];

  await t.test('binds to loopback behind a reverse proxy', () => {
    const endpoint = listenEndpoint(gateway({ tls_mode: 'reverse-proxy', listen_address: '127.0.0.1', listen_port: 10001 }));
    assert.deepEqual(endpoint, { address: '127.0.0.1', port: 10001 });
  });

  await t.test('does not fabricate TLS settings when TLS is terminated upstream', () => {
    const config = gatewayServerConfig(
      gateway({ tls_mode: 'reverse-proxy', listen_port: 10001 }), clients, egresses, 'eg_direct',
    );
    assert.equal(config.inbounds[0].streamSettings.security, undefined);
    assert.equal(config.inbounds[0].streamSettings.tlsSettings, undefined);
  });

  await t.test('includes certificate paths when Xray terminates TLS itself', () => {
    const config = gatewayServerConfig(
      gateway({ tls_mode: 'xray', tls_cert_path: '/etc/ssl/c.pem', tls_key_path: '/etc/ssl/k.pem' }),
      clients, egresses, 'eg_direct',
    );
    assert.equal(config.inbounds[0].streamSettings.security, 'tls');
    assert.deepEqual(config.inbounds[0].streamSettings.tlsSettings.certificates, [
      { certificateFile: '/etc/ssl/c.pem', keyFile: '/etc/ssl/k.pem' },
    ]);
  });

  await t.test('routes traffic through the selected egress', () => {
    const config = gatewayServerConfig(gateway(), clients, egresses, 'eg_direct');
    assert.equal(config.outbounds[0].tag, 'egress-eg_direct');
    assert.equal(config.outbounds[0].sendThrough, '203.0.113.9');
    const rule = config.routing.rules.find((r) => r.network === 'tcp,udp');
    assert.equal(rule.outboundTag, 'egress-eg_direct');
  });

  await t.test('keeps every assigned egress available as a backup outbound', () => {
    const config = gatewayServerConfig(gateway(), clients, egresses, 'eg_direct');
    const tags = config.outbounds.map((o) => o.tag);
    assert.ok(tags.includes('egress-eg_socks'));
    assert.ok(tags.includes('block'));
  });

  await t.test('gives each egress a pinned loopback probe inbound', () => {
    const config = gatewayServerConfig(gateway(), clients, egresses, 'eg_direct');
    const probes = config.inbounds.filter((i) => i.tag.startsWith('probe-'));
    assert.equal(probes.length, 2);
    assert.ok(probes.every((p) => p.listen === '127.0.0.1' && p.protocol === 'socks'));
    for (const probe of probes) {
      const egressId = probe.tag.replace('probe-', '');
      const rule = config.routing.rules.find((r) => r.inboundTag?.includes(probe.tag));
      assert.equal(rule.outboundTag, `egress-${egressId}`);
    }
  });

  await t.test('fails closed when no egress is selected', () => {
    const config = gatewayServerConfig(gateway(), clients, egresses, null);
    assert.equal(config.outbounds[0].protocol, 'blackhole');
    const clientRule = config.routing.rules.find((r) => r.inboundTag?.includes('client-in'));
    assert.equal(clientRule.outboundTag, 'block');
    // Probes still work, so the gateway can detect recovery on its own.
    assert.ok(config.routing.rules.some((r) => r.inboundTag?.[0]?.startsWith('probe-')));
  });

  await t.test('enables per-user statistics for quota accounting', () => {
    const config = gatewayServerConfig(gateway(), clients, egresses, 'eg_direct');
    assert.deepEqual(config.api.services, ['HandlerService', 'StatsService']);
    assert.equal(config.policy.levels[0].statsUserUplink, true);
    assert.equal(config.inbounds[0].settings.clients[0].email, 'cr_one');
    const api = config.inbounds.find((i) => i.tag === 'api-in');
    assert.equal(api.port, API_PORT);
    assert.equal(api.listen, '127.0.0.1');
  });

  await t.test('blocks private ranges unless explicitly disabled for a lab', () => {
    const guarded = gatewayServerConfig(gateway(), clients, egresses, 'eg_direct');
    assert.ok(guarded.routing.rules.some((r) => r.ip?.includes('169.254.0.0/16')));
    const lab = gatewayServerConfig(gateway({ block_private_ranges: 0 }), clients, egresses, 'eg_direct');
    assert.ok(!lab.routing.rules.some((r) => r.ip));
  });

  await t.test('rejects an unsupported egress kind rather than emitting nonsense', () => {
    assert.throws(() => egressOutbound({ id: 'x', kind: 'carrier-pigeon' }), /unsupported egress kind/);
  });
});
