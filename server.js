// Mac Screen Share — stream your Mac's screens to devices on the local network.
// Zero dependencies: just run `node server.js` (Node 18+).
//
//   On the Mac:      open http://localhost:8080/host  -> "Add screen" (one per external device)
//   On Android etc.: open http://<mac-ip>:8080/?screen=1  (or just :8080 to pick a screen)
//
// Signaling uses Server-Sent Events + POST; the video itself goes peer-to-peer over WebRTC.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 8080;
const clients = new Map(); // id -> SSE response
const addrs = new Map();   // id -> { remote, local } socket addresses as seen by this server
let rooms = [];            // live shares announced by the host: [{ id, name }]
let sound = false;         // host is sending the Mac's audio

const clean = a => (a || '').replace(/^::ffff:/, '');
const isLoopback = a => a === '127.0.0.1' || a === '::1';
const lanIps = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);

function send(id, msg) {
  const res = clients.get(id);
  if (res) res.write(`data: ${JSON.stringify(msg)}\n\n`);
}
function broadcastToViewers(msg) {
  for (const id of clients.keys()) if (id !== 'host') send(id, msg);
}

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
    console.log(`${new Date().toLocaleTimeString()}  ${clean(req.socket.remoteAddress).padEnd(15)}  ${req.method} ${url.pathname}${url.search}`);
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
  if (req.method === 'GET' && url.pathname === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ips: lanIps(), port: PORT }));
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    const id = url.searchParams.get('id');
    if (!id) { res.writeHead(400); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const old = clients.get(id);
    if (old && old !== res) old.end();
    clients.set(id, res);
    addrs.set(id, { remote: clean(req.socket.remoteAddress), local: clean(req.socket.localAddress) });

    if (id !== 'host') send(id, { type: 'rooms', rooms, sound, hostOnline: clients.has('host') });

    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      if (clients.get(id) !== res) return;
      clients.delete(id);
      addrs.delete(id);
      if (id === 'host') {
        rooms = []; sound = false;
        broadcastToViewers({ type: 'rooms', rooms, sound, hostOnline: false });
      } else {
        send('host', { type: 'leave', from: id });
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
        if (msg.to === 'server' && msg.type === 'rooms' && msg.from === 'host' && Array.isArray(msg.rooms)) {
          rooms = msg.rooms.map(r => ({ id: String(r.id), name: String(r.name).slice(0, 60) }));
          sound = !!msg.sound;
          broadcastToViewers({ type: 'rooms', rooms, sound, hostOnline: true });
        } else {
          if (process.env.DEBUG && msg.type === 'candidate') console.log(`[ice] ${msg.from} -> ${msg.to}: ${msg.candidate?.candidate}`);
          send(msg.to, rewriteMdns(msg));
        }
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
  console.log('\nMac Screen Share is running\n');
  console.log(`  1) On this Mac open:  http://localhost:${PORT}/host`);
  for (const ip of lanIps()) console.log(`  2) On other devices:  http://${ip}:${PORT}/?screen=1   (screen=2, 3… for more)`);
  console.log('\nPress Ctrl+C to stop.\n');
});
