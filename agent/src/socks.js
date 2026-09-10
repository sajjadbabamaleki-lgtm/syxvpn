import net from 'node:net';
import tls from 'node:tls';

/**
 * Minimal SOCKS5 CONNECT client (no auth), used to send probe traffic through
 * a specific egress via the loopback probe inbound in the generated Xray
 * config. Dependency-free on purpose: the agent runs on gateway hosts.
 */
export function socks5Connect({ proxyPort, proxyHost = '127.0.0.1', host, port, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: proxyHost, port: proxyPort });
    let stage = 'greeting';
    const fail = (msg) => {
      socket.destroy();
      reject(new Error(msg));
    };
    socket.setTimeout(timeoutMs, () => fail(`socks timeout in stage ${stage}`));
    socket.once('error', (err) => fail(`socks ${stage} error: ${err.code || err.message}`));

    socket.once('connect', () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00])); // VER, NMETHODS, NO AUTH
    });

    socket.on('data', function onData(chunk) {
      if (stage === 'greeting') {
        if (chunk[0] !== 0x05 || chunk[1] !== 0x00) return fail('socks handshake rejected');
        stage = 'connect';
        const hostBuf = Buffer.from(host, 'utf8');
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]);
        return socket.write(req);
      }
      if (stage === 'connect') {
        if (chunk[0] !== 0x05) return fail('malformed socks reply');
        if (chunk[1] !== 0x00) return fail(`socks connect failed (reply code ${chunk[1]})`);
        stage = 'ready';
        socket.removeListener('data', onData);
        socket.setTimeout(0);
        return resolve(socket);
      }
      return undefined;
    });
  });
}

/**
 * Fetches a URL through a SOCKS5 proxy and returns the HTTP status line.
 * Written as a raw request so no proxy-aware HTTP agent is required.
 */
export async function probeThroughSocks({ proxyPort, url, timeoutMs = 8000, verifyTls = true }) {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const port = Number(target.port) || (secure ? 443 : 80);
  const started = Date.now();

  let socket = await socks5Connect({ proxyPort, host: target.hostname, port, timeoutMs });
  if (secure) {
    socket = await new Promise((resolve, reject) => {
      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
        rejectUnauthorized: verifyTls,
      }, () => resolve(tlsSocket));
      tlsSocket.once('error', reject);
    });
  }

  return new Promise((resolve, reject) => {
    let buffer = '';
    const done = (fn, value) => {
      socket.destroy();
      fn(value);
    };
    const timer = setTimeout(() => done(reject, new Error('probe response timeout')), timeoutMs);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\r\n')) return;
      clearTimeout(timer);
      const statusLine = buffer.split('\r\n')[0];
      const status = Number(statusLine.split(' ')[1]);
      done(resolve, { status, latencyMs: Date.now() - started, statusLine });
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      done(reject, err);
    });
    socket.write(
      `HEAD ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.hostname}\r\n` +
      'User-Agent: cvpn-gateway-agent/0.2.0\r\nConnection: close\r\nAccept: */*\r\n\r\n',
    );
  });
}

/** Plain TCP reachability check, used as a fallback signal. */
export function tcpCheck({ host, port, timeoutMs = 5000, localAddress }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port, localAddress });
    let settled = false;
    const finish = (okValue, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok: okValue, latencyMs: okValue ? Date.now() - started : null, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, 'tcp connect'));
    socket.once('timeout', () => finish(false, 'tcp timeout'));
    socket.once('error', (err) => finish(false, `tcp ${err.code || err.message}`));
  });
}
