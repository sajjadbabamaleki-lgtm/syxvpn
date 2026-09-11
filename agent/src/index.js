import crypto from 'node:crypto';
import { loadAgentConfig } from './config.js';
import { createClient } from './client.js';
import { XrayManager } from './xray.js';
import { probeThroughSocks, tcpCheck } from './socks.js';
import { log } from './log.js';

const cfg = loadAgentConfig();
const client = createClient(cfg);
const xray = new XrayManager(cfg);

const state = {
  configVersion: null,
  configHash: null,
  structureHash: null,
  // credential id -> uuid, as currently loaded in the running Xray.
  clients: new Map(),
  probes: [],
  xrayVersion: null,
  lastError: null,
};

const clientMap = (config) => new Map(
  (config.inbounds.find((i) => i.tag === 'client-in')?.settings?.clients || [])
    .map((c) => [c.email, c.id]),
);

/**
 * Applies a client-list change through the Xray API instead of restarting.
 *
 * Returns null when the change cannot be applied live, in which case the caller
 * falls back to a full deployment.
 */
async function applyUsersLive(bundle) {
  const inbound = bundle.config.inbounds.find((i) => i.tag === (bundle.inboundTag || 'client-in'));
  if (!inbound) return null;

  const next = clientMap(bundle.config);
  const current = state.clients;
  const toAdd = [];
  const toRemove = [];
  for (const [email, id] of next) {
    // A changed uuid for the same credential is a remove plus an add.
    if (current.get(email) !== id) {
      if (current.has(email)) toRemove.push(email);
      toAdd.push({ email, id });
    }
  }
  for (const email of current.keys()) if (!next.has(email)) toRemove.push(email);
  if (!toAdd.length && !toRemove.length) return { added: 0, removed: 0 };

  const removed = await xray.removeUsers(inbound.tag, toRemove);
  if (!removed.ok) return null;
  const added = await xray.addUsers(inbound.tag, inbound.port, toAdd);
  if (!added.ok) return null;

  // Keep the on-disk config in step so a later restart starts from the truth.
  await xray.persist(bundle.config);
  return { added: added.added, removed: removed.removed };
}

/** Fetches and deploys configuration when the control plane reports a newer version. */
async function syncConfig(force = false) {
  const bundle = await client.fetchConfig();
  state.probes = bundle.probes || [];
  if (!force && bundle.version === state.configVersion && bundle.hash === state.configHash) {
    return { skipped: true, version: bundle.version };
  }

  // Only the subscriber list changed: apply it live rather than restarting and
  // dropping every connection currently on this gateway.
  const structureUnchanged = state.structureHash
    && bundle.structureHash === state.structureHash
    && xray.isSupervising();

  if (structureUnchanged && !force) {
    const live = await applyUsersLive(bundle);
    if (live) {
      state.configVersion = bundle.version;
      state.configHash = bundle.hash;
      state.clients = clientMap(bundle.config);
      state.lastError = null;
      log.info('users applied live', { version: bundle.version, ...live });
      await client.reportConfigStatus({
        version: bundle.version,
        applied: true,
        mode: 'hot',
        agentVersion: cfg.version,
        xrayVersion: state.xrayVersion || undefined,
      });
      return { applied: true, mode: 'hot', ...live };
    }
    log.warn('live user update failed, falling back to a full deploy', { version: bundle.version });
  }

  log.info('applying configuration', {
    version: bundle.version,
    hash: bundle.hash,
    clients: bundle.clientCount,
    activeEgress: bundle.activeEgressId,
  });

  const result = await xray.apply(bundle.config, bundle.version);
  state.xrayVersion = state.xrayVersion || await xray.version();

  await client.reportConfigStatus({
    version: bundle.version,
    applied: Boolean(result.applied),
    mode: 'restart',
    error: result.applied ? null : String(result.error).slice(0, 500),
    agentVersion: cfg.version,
    xrayVersion: state.xrayVersion || undefined,
  });

  if (result.applied) {
    state.configVersion = bundle.version;
    state.configHash = bundle.hash;
    state.structureHash = bundle.structureHash;
    state.clients = clientMap(bundle.config);
    state.lastError = null;
    log.info('configuration applied', { version: bundle.version });
  } else {
    state.lastError = result.error;
    log.error('configuration rejected', { version: bundle.version, error: result.error, rolledBack: Boolean(result.rolledBack) });
  }
  return result;
}

/**
 * Measures every assigned egress path from this gateway.
 *
 * The probe is sent through the loopback SOCKS inbound that the generated
 * config pins to that egress, so a success means traffic really left via that
 * path — not merely that a port answered.
 */
async function probeEgress() {
  const results = [];
  for (const probe of state.probes) {
    const url = probe.probeUrl || cfg.defaultProbeUrl;
    try {
      const response = await probeThroughSocks({
        proxyPort: probe.probePort,
        url,
        timeoutMs: cfg.probeTimeoutMs,
        verifyTls: cfg.verifyTls,
      });
      const good = response.status > 0 && response.status < 500;
      results.push({
        egressId: probe.egressId,
        status: good ? 'online' : 'degraded',
        latencyMs: response.latencyMs,
        detail: `e2e ${url} -> ${response.status}`,
      });
    } catch (err) {
      // Distinguish "the egress hop itself is unreachable" from "the path is up
      // but the probe target failed", which the operator needs to tell apart.
      let detail = `e2e failed: ${err.message}`;
      if (probe.host && probe.port) {
        const hop = await tcpCheck({ host: probe.host, port: probe.port, timeoutMs: 4000 });
        detail += hop.ok ? '; egress hop reachable' : `; egress hop unreachable (${hop.detail})`;
      }
      results.push({ egressId: probe.egressId, status: 'offline', latencyMs: null, detail: detail.slice(0, 300) });
    }
  }
  if (!results.length) return { egress: [] };
  const response = await client.reportHealth({ egress: results });
  log.info('egress health reported', {
    results: results.map((r) => `${r.egressId}:${r.status}`).join(','),
    routing: response?.routing?.changed ? response.routing : undefined,
  });
  return response;
}

async function reportUsage() {
  const stats = await xray.readStats();
  if (!stats.ok) {
    log.warn('stats unavailable', { error: stats.error });
    return null;
  }
  if (!stats.counters.length) return null;
  // reportId makes the submission idempotent on the control plane side.
  const reportId = crypto.randomUUID();
  const response = await client.reportUsage({ reportId, counters: stats.counters });
  log.info('usage reported', { counters: stats.counters.length, appliedBytes: response?.appliedBytes });
  return response;
}

async function heartbeat() {
  const response = await client.heartbeat({
    agentVersion: cfg.version,
    xrayVersion: state.xrayVersion || undefined,
    configVersion: state.configVersion ?? 0,
    configHash: state.configHash || undefined,
    status: state.lastError ? 'error' : 'ok',
    detail: state.lastError ? String(state.lastError).slice(0, 300) : undefined,
  });
  if (response?.needsConfig) await syncConfig();
  return response;
}

async function safely(name, fn) {
  try {
    return await fn();
  } catch (err) {
    log.error(`${name} failed`, { error: err.message, status: err.status, code: err.code });
    return null;
  }
}

async function main() {
  log.info('sixvpn gateway agent starting', {
    gatewayId: cfg.gatewayId,
    controlPlane: cfg.controlPlaneUrl,
    reloadMode: cfg.reloadMode,
    configPath: cfg.configPath,
  });
  state.xrayVersion = await xray.version();

  await safely('initial config sync', () => syncConfig(true));
  await safely('initial egress probe', probeEgress);

  if (cfg.once) {
    await safely('usage report', reportUsage);
    await xray.stopSupervised();
    return;
  }

  const timers = [
    setInterval(() => safely('heartbeat', heartbeat), cfg.heartbeatSeconds * 1000),
    setInterval(() => safely('egress probe', probeEgress), cfg.healthSeconds * 1000),
    setInterval(() => safely('usage report', reportUsage), cfg.usageSeconds * 1000),
  ];

  const shutdown = async (signal) => {
    log.info('shutting down', { signal });
    timers.forEach(clearInterval);
    xray.stopping = true;
    await xray.stopSupervised();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('agent failed to start', { error: err.message });
  process.exit(1);
});
