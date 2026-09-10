/**
 * Lab probe: fetches a URL either directly or through a SOCKS5 proxy and prints
 * the body. Exists so the lab containers need no extra packages installed.
 *
 *   node probe.mjs <url> [socks5://host:port]
 */
import net from 'node:net';

const [, , url, proxy] = process.argv;
const target = new URL(url);
const port = Number(target.port) || 80;
const timeout = Number(process.env.PROBE_TIMEOUT_MS || 8000);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function httpGet(socket) {
  let buffer = '';
  const timer = setTimeout(() => fail('response timeout'), timeout);
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    if (!buffer.includes('\r\n\r\n')) return;
    clearTimeout(timer);
    const [head, ...rest] = buffer.split('\r\n\r\n');
    const status = Number(head.split('\r\n')[0].split(' ')[1]);
    process.stdout.write(`${rest.join('\r\n\r\n').trim()}\n`);
    socket.destroy();
    process.exit(status >= 200 && status < 400 ? 0 : 1);
  });
  socket.on('error', (err) => fail(`socket error: ${err.code || err.message}`));
  // HTTP/1.0 keeps the response unchunked, so the body prints verbatim.
  socket.write(
    `GET ${target.pathname}${target.search} HTTP/1.0\r\nHost: ${target.hostname}\r\n` +
    'Connection: close\r\nUser-Agent: cvpn-lab-probe\r\n\r\n',
  );
}

if (!proxy) {
  const socket = net.createConnection({ host: target.hostname, port });
  socket.setTimeout(timeout, () => fail('connect timeout'));
  socket.once('connect', () => { socket.setTimeout(0); httpGet(socket); });
  socket.once('error', (err) => fail(`connect error: ${err.code || err.message}`));
} else {
  const proxyUrl = new URL(proxy);
  const socket = net.createConnection({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });
  let stage = 'greeting';
  socket.setTimeout(timeout, () => fail(`socks timeout in ${stage}`));
  socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
  socket.once('error', (err) => fail(`socks error: ${err.code || err.message}`));
  socket.on('data', function onData(chunk) {
    if (stage === 'greeting') {
      if (chunk[0] !== 0x05 || chunk[1] !== 0x00) fail('socks handshake rejected');
      stage = 'connect';
      const host = Buffer.from(target.hostname, 'utf8');
      socket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
        host,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]));
      return;
    }
    if (stage === 'connect') {
      if (chunk[1] !== 0x00) fail(`socks connect failed (code ${chunk[1]})`);
      stage = 'ready';
      socket.removeListener('data', onData);
      socket.setTimeout(0);
      httpGet(socket);
    }
  });
}
