import path from 'node:path';

const int = (v, d) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

/**
 * SYXVPN_* is what these are called. The earlier names are still read, because
 * a gateway that is already running has them in its env file — read by a
 * container an upgrade restarts, not by somebody at a keyboard. Falling back
 * keeps that gateway working until its file is rewritten.
 */
const NAMES = ['SYXVPN', 'CVPN', 'JORDAN'];
const read = (env, name) => NAMES.map((prefix) => env[`${prefix}_${name}`]).find(Boolean);

export function loadAgentConfig(env = process.env) {
  const missing = ['URL', 'GATEWAY_ID', 'AGENT_KEY'].filter((k) => !read(env, k));
  if (missing.length) {
    throw new Error(`missing required environment: ${missing.map((k) => `SYXVPN_${k}`).join(', ')}`);
  }
  const stateDir = env.STATE_DIR || '/var/lib/cvpn-agent';
  return {
    controlPlaneUrl: read(env, 'URL').replace(/\/+$/, ''),
    gatewayId: read(env, 'GATEWAY_ID'),
    agentKey: read(env, 'AGENT_KEY'),

    stateDir,
    configPath: env.XRAY_CONFIG_PATH || path.join(stateDir, 'xray.json'),
    lastGoodPath: env.XRAY_LAST_GOOD_PATH || path.join(stateDir, 'xray.last-good.json'),

    xrayBin: env.XRAY_BIN || 'xray',
    // supervise: the agent runs Xray as a child process and restarts it.
    // command:   an external supervisor is reloaded via RELOAD_COMMAND.
    reloadMode: env.RELOAD_MODE || 'supervise',
    reloadCommand: env.RELOAD_COMMAND || 'systemctl reload xray',

    apiPort: int(env.XRAY_API_PORT, 10085),
    heartbeatSeconds: int(env.HEARTBEAT_SECONDS, 30),
    healthSeconds: int(env.HEALTH_SECONDS, 60),
    usageSeconds: int(env.USAGE_SECONDS, 60),
    probeTimeoutMs: int(env.PROBE_TIMEOUT_MS, 8000),
    startupTimeoutMs: int(env.STARTUP_TIMEOUT_MS, 10000),
    defaultProbeUrl: env.DEFAULT_PROBE_URL || 'http://connectivitycheck.gstatic.com/generate_204',
    verifyTls: bool(env.PROBE_VERIFY_TLS, true),
    once: process.argv.includes('--once'),
    version: '0.2.0',
  };
}
