// Mac Screen Share — stream your Mac screen to any device on the local network.
// Zero dependencies: just run `node server.js` (Node 18+).
//
//   On the Mac:      open http://localhost:8080/host  -> click "Start sharing"
//   On Android etc.: open http://<mac-ip>:8080        -> video appears
//
// Signaling uses Server-Sent Events + POST; the video itself goes peer-to-peer over WebRTC.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 8080;
const clients = new Map(); // id -> SSE response
const addrs = new Map();   // id -> { remote, local } socket addresses as seen by this server

const clean = a => (a || '').replace(/^::ffff:/, '');
const isLoopback = a => a === '127.0.0.1' || a === '::1';

// Chrome hides local IPs in WebRTC candidates behind random "xxxx.local" mDNS names.
// Resolving those fails when Chrome lacks macOS "Local Network" permission, on VPNs, or
// on networks that block multicast — and then the video never connects. We know every
// peer's real address from its HTTP connection, so swap the mDNS name for it.
function realAddress(fromId, toId) {
  const from = addrs.get(fromId), to = addrs.get(toId);
  if (!from) return null;
  if (!isLoopback(from.remote)) return from.remote;          // sender is another device
  if (to && !isLoopback(to.remote)) return to.local;         // sender is this Mac; use the IP the receiver reached us on
  return '127.0.0.1';                                        // both on this Mac
}

function fixCandidateLine(line, ip) {
  return line.replace(/^((?:a=)?candidate:\S+ \d+ \S+ \d+ )([0-9a-f-]+\.local)( )/i, `$1${ip}$3`);
}

function rewriteMdns(msg) {
  const ip = realAddress(msg.from, msg.to);
  if (!ip) return msg;
  if (msg.candidate && typeof msg.candidate.candidate === 'string') {
    msg.candidate = { ...msg.candidate, candidate: fixCandidateLine(msg.candidate.candidate, ip) };
  }
  if (msg.sdp && typeof msg.sdp.sdp === 'string') {
    msg.sdp = { ...msg.sdp, sdp: msg.sdp.sdp.split('\r\n').map(l => fixCandidateLine(l, ip)).join('\r\n') };
  }
  return msg;
}

function send(id, msg) {
  const res = clients.get(id);
  if (res) res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

function broadcastToViewers(msg) {
  for (const id of clients.keys()) if (id !== 'host') send(id, msg);
}

function serveFile(res, file, type) {
  fs.readFile(path.join(__dirname, file), (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/signal' || process.env.DEBUG) {
    console.log(`${new Date().toLocaleTimeString()}  ${clean(req.socket.remoteAddress).padEnd(15)}  ${req.method} ${url.pathname}`);
  }

  if (req.method === 'GET' && url.pathname === '/') return serveFile(res, 'viewer.html', 'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/host') {
    // Screen capture requires a secure context; localhost counts, a LAN IP does not.
    const host = (req.headers.host || '').split(':')[0];
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
      res.writeHead(302, { Location: `http://localhost:${PORT}/host` });
      return res.end();
    }
    return serveFile(res, 'host.html', 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    const id = url.searchParams.get('id');
    if (!id) { res.writeHead(400); return res.end(); }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const old = clients.get(id);
    if (old && old !== res) old.end();
    clients.set(id, res);
    addrs.set(id, { remote: clean(req.socket.remoteAddress), local: clean(req.socket.localAddress) });

    if (id === 'host') {
      broadcastToViewers({ type: 'host-ready' });
      send('host', { type: 'viewer-count', count: [...clients.keys()].filter(k => k !== 'host').length });
    } else {
      send(id, { type: clients.has('host') ? 'host-ready' : 'host-offline' });
      send('host', { type: 'viewer-count', count: [...clients.keys()].filter(k => k !== 'host').length });
    }

    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      if (clients.get(id) !== res) return;
      clients.delete(id);
      addrs.delete(id);
      if (id === 'host') broadcastToViewers({ type: 'host-offline' });
      else {
        send('host', { type: 'leave', from: id });
        send('host', { type: 'viewer-count', count: [...clients.keys()].filter(k => k !== 'host').length });
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/signal') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        if (typeof msg.to !== 'string' || typeof msg.from !== 'string') throw new Error('missing to/from');
        if (process.env.DEBUG && msg.type === 'candidate') console.log(`[ice] ${msg.from} -> ${msg.to}: ${msg.candidate?.candidate}`);
        send(msg.to, rewriteMdns(msg));
        res.writeHead(204); res.end();
      } catch {
        res.writeHead(400); res.end();
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('\nMac Screen Share is running\n');
  console.log(`  1) On this Mac open:      http://localhost:${PORT}/host`);
  for (const ip of ips) console.log(`  2) On the Android device: http://${ip}:${PORT}`);
  console.log('\nPress Ctrl+C to stop.\n');
});
