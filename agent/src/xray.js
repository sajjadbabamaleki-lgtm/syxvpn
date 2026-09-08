import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import { log } from './log.js';

/**
 * Xray lifecycle management with a last-known-good guarantee.
 *
 * Deployment sequence:
 *   fetch -> validate -> write temp -> `xray -test` -> keep current as
 *   last-known-good -> atomic rename -> reload -> verify listening -> report
 *
 * If any step fails the running configuration is left untouched; if the
 * process fails to come back after a reload, the last-known-good file is
 * restored and applied. A broken control-plane update can therefore never
 * leave a gateway without a working configuration.
 */
export class XrayManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.child = null;
    this.stopping = false;
    fs.mkdirSync(path.dirname(cfg.configPath), { recursive: true });
    fs.mkdirSync(cfg.stateDir, { recursive: true });
  }

  /** Structural validation before the binary is ever invoked. */
  static validate(config) {
    const problems = [];
    if (!config || typeof config !== 'object') problems.push('config is not an object');
    if (!Array.isArray(config?.inbounds) || !config.inbounds.length) problems.push('no inbounds');
    if (!Array.isArray(config?.outbounds) || !config.outbounds.length) problems.push('no outbounds');
    const inbound = config?.inbounds?.find((i) => i.tag === 'client-in');
    if (!inbound) problems.push('missing client-in inbound');
    else if (!inbound.port) problems.push('client-in inbound has no port');
    return problems;
  }

  async version() {
    return new Promise((resolve) => {
      execFile(this.cfg.xrayBin, ['version'], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve(null);
        // "Xray 26.3.27 (Xray, Penetrates Everything.) ..." -> "Xray 26.3.27"
        const first = String(stdout).split('\n')[0].trim();
        const match = /^(\S+\s+\S+)/.exec(first);
        return resolve((match ? match[1] : first).slice(0, 64));
      });
    });
  }

  /** Runs `xray -test` against a candidate file. */
  testConfig(file) {
    return new Promise((resolve) => {
      execFile(this.cfg.xrayBin, ['-test', '-config', file], { timeout: 15000 }, (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true });
        const output = `${stdout || ''}${stderr || ''}`.trim();
        // Older/newer binaries disagree on flag style; try the `run` form.
        if (/unknown|flag provided but not defined|unexpected/i.test(output)) {
          return execFile(this.cfg.xrayBin, ['run', '-test', '-c', file], { timeout: 15000 }, (err2, out2, errout2) => {
            if (!err2) return resolve({ ok: true });
            return resolve({ ok: false, error: `${out2 || ''}${errout2 || ''}`.trim() || err2.message });
          });
        }
        return resolve({ ok: false, error: output || err.message });
      });
    });
  }

  async waitForApi(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const up = await new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: this.cfg.apiPort });
        socket.setTimeout(1000);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
      });
      if (up) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  startSupervised() {
    if (this.child) return;
    const child = spawn(this.cfg.xrayBin, ['run', '-c', this.cfg.configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.on('data', (d) => log.info('xray', { out: String(d).trim().slice(0, 300) }));
    child.stderr.on('data', (d) => log.warn('xray', { err: String(d).trim().slice(0, 300) }));
    child.on('exit', (code, signal) => {
      this.child = null;
      if (!this.stopping) log.warn('xray exited', { code, signal });
    });
  }

  async stopSupervised() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 4000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  async reload() {
    if (this.cfg.reloadMode === 'supervise') {
      await this.stopSupervised();
      this.startSupervised();
      return { ok: true, mode: 'supervise' };
    }
    return new Promise((resolve) => {
      const [bin, ...args] = this.cfg.reloadCommand.split(' ');
      execFile(bin, args, { timeout: 20000 }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, mode: 'command', error: `${stderr || stdout || err.message}`.trim() });
        return resolve({ ok: true, mode: 'command' });
      });
    });
  }

  /**
   * Applies a new configuration. Returns `{ applied, error, rolledBack }`.
   */
  async apply(config, version) {
    const problems = XrayManager.validate(config);
    if (problems.length) {
      return { applied: false, error: `validation failed: ${problems.join('; ')}` };
    }

    const serialized = `${JSON.stringify(config, null, 2)}\n`;
    // Xray infers the config format from the file extension, so the candidate
    // file must still end in .json.
    const candidate = this.cfg.configPath.replace(/(\.json)?$/, '.next.json');
    await fsp.writeFile(candidate, serialized, { mode: 0o600 });

    const test = await this.testConfig(candidate);
    if (!test.ok) {
      await fsp.rm(candidate, { force: true });
      return { applied: false, error: `xray -test rejected config v${version}: ${String(test.error).slice(0, 400)}` };
    }

    // Keep the currently running configuration as last-known-good *before*
    // replacing it, so a failed reload can be undone.
    let hadPrevious = false;
    try {
      await fsp.copyFile(this.cfg.configPath, this.cfg.lastGoodPath);
      hadPrevious = true;
    } catch { /* first deployment: nothing to preserve */ }

    await fsp.rename(candidate, this.cfg.configPath);
    const reloaded = await this.reload();
    const up = reloaded.ok && await this.waitForApi(this.cfg.startupTimeoutMs);

    if (!up) {
      if (hadPrevious) {
        log.error('rolling back to last known good configuration', { version });
        await fsp.copyFile(this.cfg.lastGoodPath, this.cfg.configPath);
        await this.reload();
        const recovered = await this.waitForApi(this.cfg.startupTimeoutMs);
        return {
          applied: false,
          rolledBack: true,
          recovered,
          error: `config v${version} did not come up; rolled back to last known good (recovered=${recovered})`,
        };
      }
      return { applied: false, error: `config v${version} did not come up and there is no previous configuration` };
    }

    return { applied: true };
  }

  /**
   * Reads cumulative per-user counters from the Xray stats API.
   * Counters are NOT reset: the control plane derives deltas, which keeps
   * accounting correct across lost reports and agent restarts.
   */
  readStats() {
    return new Promise((resolve) => {
      execFile(
        this.cfg.xrayBin,
        ['api', 'statsquery', `--server=127.0.0.1:${this.cfg.apiPort}`, '-pattern', 'user>>>'],
        { timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return resolve({ ok: false, error: `${stderr || err.message}`.trim().slice(0, 300), counters: [] });
          try {
            const parsed = JSON.parse(stdout || '{}');
            const stats = parsed.stat || parsed.stats || [];
            const byCredential = new Map();
            for (const entry of stats) {
              // user>>><email>>>>traffic>>>uplink|downlink
              const match = /^user>>>(.+?)>>>traffic>>>(uplink|downlink)$/.exec(entry.name || '');
              if (!match) continue;
              const [, credentialId, direction] = match;
              const record = byCredential.get(credentialId) || { credentialId, uplink: 0, downlink: 0 };
              record[direction] = Number(entry.value || 0);
              byCredential.set(credentialId, record);
            }
            return resolve({ ok: true, counters: [...byCredential.values()] });
          } catch (parseError) {
            return resolve({ ok: false, error: `stats parse failed: ${parseError.message}`, counters: [] });
          }
        },
      );
    });
  }
}
