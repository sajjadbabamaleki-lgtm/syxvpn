import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../lib/validate.js';
import { ok } from '../lib/respond.js';
import { requireAgent } from '../auth/agent.js';
import { buildGatewayConfig, egressProbePlan, recordDeployment } from '../domain/gateways.js';
import { decryptSecrets } from '../domain/egresses.js';
import { applyAgentEgressHealth } from '../domain/health.js';
import { ingestUsageReport } from '../domain/usage.js';
import { EVENT, recordEvent } from '../domain/events.js';
import { gatewayServerConfig, stableStringify, structuralConfig } from '../domain/xray.js';
import { entitledCredentials } from '../domain/gateways.js';
import { sha256 } from '../lib/crypto.js';
import { createRateLimiter } from '../lib/ratelimit.js';
import { config } from '../config.js';

const heartbeatSchema = z.object({
  agentVersion: z.string().trim().max(32).optional(),
  xrayVersion: z.string().trim().max(64).optional(),
  configVersion: z.coerce.number().int().min(0).optional(),
  configHash: z.string().trim().max(64).optional(),
  status: z.enum(['ok', 'degraded', 'error']).default('ok'),
  detail: z.string().trim().max(300).optional(),
});

const configStatusSchema = z.object({
  version: z.coerce.number().int().min(0),
  applied: z.boolean(),
  // 'hot' means users were changed through the Xray API without a restart.
  mode: z.enum(['restart', 'hot', 'unchanged']).optional(),
  error: z.string().trim().max(500).nullish(),
  agentVersion: z.string().trim().max(32).optional(),
  xrayVersion: z.string().trim().max(64).optional(),
});

const healthSchema = z.object({
  egress: z.array(z.object({
    egressId: z.string().trim().min(3).max(64),
    status: z.enum(['online', 'degraded', 'offline']),
    latencyMs: z.coerce.number().int().min(0).max(120000).nullish(),
    detail: z.string().trim().max(300).optional(),
  })).max(50).default([]),
});

const usageSchema = z.object({
  reportId: z.string().trim().min(8).max(80),
  counters: z.array(z.object({
    credentialId: z.string().trim().min(3).max(64),
    uplink: z.coerce.number().int().min(0),
    downlink: z.coerce.number().int().min(0),
  })).max(2000).default([]),
});

function markAgentSeen(db, gateway, patch = {}) {
  const now = Date.now();
  const wasStale = gateway.agent_status !== 'online';
  db.prepare(`UPDATE gateways SET agent_status='online', agent_last_seen_at=?,
      agent_version=COALESCE(?, agent_version), xray_version=COALESCE(?, xray_version), updated_at=?
      WHERE id=?`)
    .run(now, patch.agentVersion ?? null, patch.xrayVersion ?? null, now, gateway.id);
  if (wasStale && gateway.agent_status === 'stale') {
    recordEvent(db, {
      type: EVENT.AGENT_RECOVERED, targetType: 'gateway', targetId: gateway.id,
      message: `${gateway.name}: agent heartbeat recovered`,
    });
  }
}

export function agentRoutes({ db }) {
  const router = Router();
  router.use(createRateLimiter({
    ...config.rateLimit.agent,
    keyFn: (req) => `agent:${req.get('x-jordan-gateway') || 'unknown'}`,
  }));
  router.use(requireAgent(db));

  router.post('/heartbeat', validate(heartbeatSchema), (req, res) => {
    const gateway = req.gateway;
    markAgentSeen(db, gateway, req.body);
    if (req.body.status === 'error') {
      recordEvent(db, {
        type: 'agent.error', severity: 'warning', targetType: 'gateway', targetId: gateway.id,
        message: `${gateway.name}: agent reported an error — ${req.body.detail || 'no detail'}`,
      });
    }
    return ok(res, {
      configVersion: gateway.config_version,
      needsConfig: req.body.configVersion !== gateway.config_version,
      serverTime: new Date().toISOString(),
    });
  });

  // The full data-plane configuration, including egress credentials. Only an
  // authenticated agent for this specific gateway can reach it.
  router.get('/config', (req, res) => {
    const gateway = req.gateway;
    markAgentSeen(db, gateway);
    const clients = entitledCredentials(db);
    const egresses = decryptSecrets(
      db.prepare(`SELECT e.*, ge.priority AS assign_priority FROM gateway_egress ge
                  JOIN egresses e ON e.id = ge.egress_id WHERE ge.gateway_id = ?
                  ORDER BY ge.priority, e.priority`).all(gateway.id),
    );
    const xray = gatewayServerConfig(gateway, clients, egresses, gateway.active_egress_id);
    return ok(res, {
      gatewayId: gateway.id,
      version: gateway.config_version,
      hash: sha256(stableStringify(xray)).slice(0, 16),
      // Lets the agent apply a pure client-list change without a restart.
      structureHash: sha256(stableStringify(structuralConfig(xray))).slice(0, 16),
      inboundTag: 'client-in',
      activeEgressId: gateway.active_egress_id,
      clientCount: clients.length,
      probes: egressProbePlan(db, gateway.id),
      config: xray,
    });
  });

  router.post('/config-status', validate(configStatusSchema), (req, res) => {
    const gateway = req.gateway;
    markAgentSeen(db, gateway, req.body);
    recordDeployment(db, gateway.id, {
      version: req.body.version,
      ok: req.body.applied,
      error: req.body.error,
      agentVersion: req.body.agentVersion,
      xrayVersion: req.body.xrayVersion,
      mode: req.body.mode,
    });
    return ok(res, { acknowledged: true });
  });

  router.post('/health', validate(healthSchema), (req, res) => {
    const gateway = req.gateway;
    markAgentSeen(db, gateway);
    const result = applyAgentEgressHealth(db, gateway.id, req.body.egress);
    const refreshed = db.prepare('SELECT config_version FROM gateways WHERE id=?').get(gateway.id);
    return ok(res, { ...result, configVersion: refreshed.config_version });
  });

  router.post('/usage', validate(usageSchema), (req, res) => {
    const gateway = req.gateway;
    markAgentSeen(db, gateway);
    const result = ingestUsageReport(db, gateway.id, req.body);
    const refreshed = db.prepare('SELECT config_version FROM gateways WHERE id=?').get(gateway.id);
    return ok(res, { ...result, configVersion: refreshed.config_version });
  });

  return router;
}
