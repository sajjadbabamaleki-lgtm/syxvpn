const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

export function gatewayView(g, extra = {}) {
  return {
    id: g.id,
    name: g.name,
    region: g.region,
    host: g.host,
    port: g.port,
    protocol: g.protocol,
    transport: g.transport,
    tlsMode: g.tls_mode,
    tls: g.tls_mode !== 'none',
    sni: g.sni,
    wsPath: g.ws_path,
    wsHost: g.ws_host,
    listenAddress: g.listen_address,
    listenPort: g.listen_port,
    priority: g.priority,
    enabled: g.enabled === 1,
    blockPrivateRanges: g.block_private_ranges === 1,
    ingress: {
      status: g.ingress_status,
      latencyMs: g.ingress_latency_ms,
      checkedAt: iso(g.ingress_checked_at),
      failCount: g.ingress_fail_count,
      detail: g.ingress_detail,
    },
    agent: {
      status: g.agent_status,
      version: g.agent_version,
      xrayVersion: g.xray_version,
      lastSeenAt: iso(g.agent_last_seen_at),
      keyIssued: Boolean(g.agent_key_enc),
      keyHint: g.agent_key_hint,
      keyIssuedAt: iso(g.agent_key_created_at),
    },
    config: {
      version: g.config_version,
      deployedVersion: g.deployed_config_version,
      deployedAt: iso(g.deployed_at),
      inSync: g.deployed_config_version === g.config_version,
      error: g.deploy_error,
    },
    activeEgressId: g.active_egress_id,
    activeEgressSince: iso(g.active_egress_since),
    activeEgressReason: g.active_egress_reason,
    createdAt: iso(g.created_at),
    updatedAt: iso(g.updated_at),
    ...extra,
  };
}

/** Egress view for operators. The credential is never serialised. */
export function egressView(e, extra = {}) {
  return {
    id: e.id,
    name: e.name,
    region: e.region,
    kind: e.kind,
    host: e.host,
    port: e.port,
    bindAddress: e.bind_address,
    username: e.username,
    hasSecret: Boolean(e.secret),
    tls: e.tls === 1,
    sni: e.sni,
    transport: e.transport,
    wsPath: e.ws_path,
    probeUrl: e.probe_url,
    priority: e.priority,
    weight: e.weight,
    enabled: e.enabled === 1,
    status: e.status,
    latencyMs: e.latency_ms,
    checkedAt: iso(e.checked_at),
    checkedBy: e.checked_by,
    detail: e.detail,
    authorizationNote: e.authorization_note,
    createdAt: iso(e.created_at),
    updatedAt: iso(e.updated_at),
    ...extra,
  };
}

export function subscriberView(s, extra = {}) {
  const remaining = s.quota_bytes > 0 ? Math.max(0, s.quota_bytes - s.used_bytes) : null;
  return {
    id: s.id,
    name: s.name,
    tokenPrefix: s.token_prefix,
    quotaBytes: s.quota_bytes,
    usedBytes: s.used_bytes,
    remainingBytes: remaining,
    usedFraction: s.quota_bytes > 0 ? Math.min(1, s.used_bytes / s.quota_bytes) : null,
    expiresAt: iso(s.expires_at),
    status: s.status,
    note: s.note,
    createdAt: iso(s.created_at),
    updatedAt: iso(s.updated_at),
    lastFetchAt: iso(s.last_fetch_at),
    fetchCount: s.fetch_count,
    ...extra,
  };
}

export function healthCheckView(h) {
  return {
    id: h.id,
    targetType: h.target_type,
    targetId: h.target_id,
    gatewayId: h.gateway_id,
    kind: h.check_kind,
    status: h.status,
    latencyMs: h.latency_ms,
    detail: h.detail,
    source: h.source,
    createdAt: iso(h.created_at),
  };
}

export function routeSwitchView(r) {
  return r && {
    id: r.id,
    gatewayId: r.gateway_id,
    fromEgressId: r.from_egress_id,
    toEgressId: r.to_egress_id,
    reason: r.reason,
    createdAt: iso(r.created_at),
  };
}

export { iso };
