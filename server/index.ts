import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { RoomCore, type RoomContext, type RoomSocket, type Attachment } from '../src/room-core';
import type { GameState, LogEvent } from '../src/types';
import { Store } from './storage';
import { Limiter, clientIp } from './security';
import { linksFor } from '../src/protocol';

function integer(name: string, fallback: number, minimum = 1) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
  return value;
}
const port = integer('PORT', 8787), host = process.env.HOST ?? '127.0.0.1';
const origin = new URL(process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`).origin;
const secure = origin.startsWith('https:');
if (!secure && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('PUBLIC_ORIGIN must use HTTPS outside localhost');
const password = process.env.ADMIN_PASSWORD_FILE ? readFileSync(process.env.ADMIN_PASSWORD_FILE, 'utf8').trim() : process.env.ADMIN_PASSWORD;
if (!password || password.length < 16 || password.length > 256) throw new Error('Set ADMIN_PASSWORD_FILE or ADMIN_PASSWORD with 16 to 256 characters');
const username = process.env.ADMIN_USERNAME ?? 'admin';
if (!username || username.length > 64) throw new Error('ADMIN_USERNAME requires 1 to 64 characters');
const usernameHash = hashUsername(username);
function hashUsername(value: string) { return createHash('sha256').update(value).digest(); }
const salt = randomBytes(16), passwordHash = scryptSync(password, salt, 32);
const maxRooms = integer('MAX_ROOMS', 1000), maxConnections = integer('MAX_CONNECTIONS', 512);
const maxRoomBytes = integer('MAX_ROOM_BYTES', 4 * 1024 * 1024);
const maxCacheBytes = 24 * 1024 * 1024;
const store = new Store(process.env.DATABASE_PATH ?? 'data/hidden-crown.sqlite', integer('MAX_DATABASE_BYTES', 256 * 1024 * 1024));
const authSalt = String(store.db.prepare("SELECT value FROM metadata WHERE key='auth_salt'").get()?.value ?? randomBytes(16).toString('hex'));
const fingerprint = scryptSync(`${username}\0${password}`, authSalt, 32).toString('hex');
if (store.db.prepare("SELECT value FROM metadata WHERE key='auth_fingerprint'").get()?.value !== fingerprint) store.db.exec('DELETE FROM sessions');
const putMetadata = store.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
putMetadata.run('auth_salt', authSalt); putMetadata.run('auth_fingerprint', fingerprint);
const initialWait = integer('WAITING_TIMEOUT_MINUTES', 15);
if (initialWait > 1440) throw new Error('WAITING_TIMEOUT_MINUTES must be 1 to 1440');
if (!store.db.prepare("SELECT value FROM metadata WHERE key='waiting_minutes'").get()) putMetadata.run('waiting_minutes', String(initialWait));
const waitingMinutes = () => Number(store.db.prepare("SELECT value FROM metadata WHERE key='waiting_minutes'").get()!.value);
const proxies = new Set((process.env.TRUSTED_PROXIES ?? '').split(',').map(value => value.trim()).filter(Boolean));
for (const peer of proxies) if (!/^[\da-fA-F:.]+$/.test(peer)) throw new Error('TRUSTED_PROXIES requires exact IP addresses');
const requests = new Limiter(120, 60000), globalRequests = new Limiter(2000, 60000, 1);
const creates = new Limiter(integer('CREATE_LIMIT_PER_IP', 5), 600000);
const globalCreates = new Limiter(integer('CREATE_LIMIT_GLOBAL', 50), 600000, 1);
const loginAttempts = new Limiter(5, 900000), globalLogins = new Limiter(30, 900000, 1);
const upgrades = new Limiter(30, 60000), messages = new Limiter(30, 1000, maxConnections);
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', pattern = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const runtimeRooms = new Map<string, RuntimeRoom>();
let admission = Promise.resolve();
function serializeAdmission<T>(callback: () => Promise<T>): Promise<T> {
  const result = admission.then(callback); admission = result.then(() => {}, () => {}); return result;
}
class Socket implements RoomSocket {
  private data: Attachment | null = null;
  id = randomUUID();
  constructor(readonly ws: WebSocket) {}
  get readyState() { return this.ws.readyState; }
  serializeAttachment(value: Attachment) { this.data = value; }
  deserializeAttachment() { return this.data; }
  send(data: string) {
    if (this.ws.bufferedAmount > 1024 * 1024) { this.ws.terminate(); return; }
    this.ws.send(data);
  }
  close(code = 1000, reason = '') { this.ws.close(code, reason); }
}
class RuntimeRoom implements RoomContext {
  core: RoomCore;
  sockets = new Set<Socket>();
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  alarmTimer?: NodeJS.Timeout;
  lastAccess = Date.now();
  bytes = 0;
  deleting = false;
  storage: RoomContext['storage'];
  constructor(readonly id: string) {
    this.bytes = Number(store.db.prepare('SELECT bytes FROM rooms WHERE id=?').get(id)?.bytes ?? 0);
    this.storage = {
      get: async <T>(key: string) => {
        const row = store.row(id); return row ? JSON.parse(String(row[key])) as T : undefined;
      },
      transaction: async callback => callback({ put: async values => {
        if (this.deleting) throw new Error('room_deleted');
        const nextBytes = Buffer.byteLength(JSON.stringify(values.state)) + Buffer.byteLength(JSON.stringify(values.log));
        ensureCacheBudget(this.id, nextBytes);
        store.write(values.state as GameState, values.log as LogEvent[], maxRoomBytes);
        this.bytes = nextBytes;
      } }),
      setAlarm: async at => {
        clearTimeout(this.alarmTimer);
        this.alarmTimer = setTimeout(() => this.core.alarm().catch(() => {}), Math.max(1, at - Date.now()));
        this.alarmTimer.unref();
      }
    };
    this.core = new RoomCore(this);
  }
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    if (this.queued >= 64) return Promise.reject(new Error('room_busy'));
    this.queued++;
    const result = this.queue.then(callback);
    this.queue = result.then(() => {}, () => {}).finally(() => { this.queued--; });
    return result;
  }
  getWebSockets() { this.lastAccess = Date.now(); return [...this.sockets]; }
  get busy() { return this.queued > 0; }
}
function getRoom(id: string) {
  let room = runtimeRooms.get(id);
  if (!room) {
    // Keep only a bounded number of loaded rooms, without ever evicting live or busy rooms.
    ensureCacheBudget(id, Number(store.db.prepare('SELECT bytes FROM rooms WHERE id=?').get(id)?.bytes ?? 0));
    if (runtimeRooms.size >= 64) {
      for (const [key, old] of runtimeRooms) if (!old.sockets.size && !old.busy) { clearTimeout(old.alarmTimer); runtimeRooms.delete(key); break; }
      if (runtimeRooms.size >= 64) throw new Error('server_busy');
    }
    room = new RuntimeRoom(id); runtimeRooms.set(id, room);
  }
  room.lastAccess = Date.now(); return room;
}
function ensureCacheBudget(id: string, incomingBytes: number) {
  let total = incomingBytes;
  for (const [key, room] of runtimeRooms) if (key !== id) total += room.bytes;
  if (total > maxCacheBytes) {
    for (const [key, old] of runtimeRooms) {
      if (key !== id && !old.sockets.size && !old.busy) { total -= old.bytes; clearTimeout(old.alarmTimer); runtimeRooms.delete(key); }
      if (total <= maxCacheBytes) break;
    }
    if (total > maxCacheBytes) throw new Error('server_busy');
  }
}
async function removeRoom(id: string, expired = false) {
  const room = runtimeRooms.get(id);
  const remove = async () => {
    const row = store.db.prepare('SELECT phase,created_at FROM rooms WHERE id=?').get(id);
    if (!row || (expired && (!['lobby', 'crown_select'].includes(String(row.phase)) || Number(row.created_at) + waitingMinutes() * 60000 > Date.now()))) return;
    if (room) room.deleting = true;
    store.delete(id, expired ? 'room_expired' : 'room_deleted');
    if (room) {
      for (const socket of room.sockets) {
        socket.serializeAttachment({ ...socket.deserializeAttachment()!, active: false });
        socket.ws.close(4001, expired ? 'room_expired' : 'room_deleted');
      }
      clearTimeout(room.alarmTimer); runtimeRooms.delete(id);
    }
  };
  if (room) await room.blockConcurrencyWhile(remove); else await remove();
}
let expiryTask: Promise<void> | null = null;
function expireWaitingRooms() {
  if (expiryTask) return expiryTask;
  expiryTask = (async () => {
    const rows = store.db.prepare("SELECT id FROM rooms WHERE phase IN ('lobby','crown_select') AND created_at<=?").all(Date.now() - waitingMinutes() * 60000);
    for (const row of rows) await removeRoom(String(row.id), true);
  })().finally(() => { expiryTask = null; });
  return expiryTask;
}
function json(res: ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage, maximum = 4096) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maximum) throw new Error('body_too_large'); chunks.push(chunk); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bad_request');
  return value as Record<string, unknown>;
}
function session(req: IncomingMessage) {
  const cookie = /(?:^|;\s*)hc_admin=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '');
  if (!cookie) return null;
  const row = store.db.prepare('SELECT csrf,expires FROM sessions WHERE hash=? AND expires>?').get(hash(cookie[1]), Date.now());
  return row ? { hash: hash(cookie[1]), csrf: String(row.csrf) } : null;
}
function sameOrigin(req: IncomingMessage) { return !req.headers.origin || req.headers.origin === origin; }
const assets = new Map<string, { content: Buffer; type: string }>();
for (const [route, file, type] of [
  ['/', 'index.html', 'text/html'], ['/styles.css', 'styles.css', 'text/css'],
  ['/js/app.js', 'js/app.js', 'text/javascript'], ['/js/board.js', 'js/board.js', 'text/javascript'], ['/js/i18n.js', 'js/i18n.js', 'text/javascript'],
  ['/admin', 'admin.html', 'text/html'], ['/js/admin.js', 'js/admin.js', 'text/javascript'], ['/js/icons.js', 'js/icons.js', 'text/javascript'],
  ['/js/pieces.js', 'js/pieces.js', 'text/javascript'], ['/js/board-motion.js', 'js/board-motion.js', 'text/javascript'], ['/js/replay.js', 'js/replay.js', 'text/javascript']
]) assets.set(route, { content: readFileSync(fileURLToPath(new URL(`../public/${file}`, import.meta.url))), type });
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    const url = new URL(req.url ?? '/', origin), path = url.pathname;
    if (req.headers.host !== new URL(origin).host) return json(res, 403, { code: 'host_denied' });
    const ip = clientIp(req, proxies);
    if (!requests.take(ip) || !globalRequests.take('all')) return json(res, 429, { code: 'rate_limited' }, { 'Retry-After': '60' });
    if (!sameOrigin(req)) return json(res, 403, { code: 'origin_denied' });
    if (path === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true });
    if (path === '/api/admin/login') {
      if (req.method !== 'POST') return json(res, 405, { code: 'bad_request' }, { Allow: 'POST' });
      if (!loginAttempts.take(ip) || !globalLogins.take('all')) return json(res, 429, { code: 'rate_limited' }, { 'Retry-After': '900' });
      const value = await body(req);
      const supplied = typeof value.password === 'string' ? value.password : '';
      const validPassword = supplied.length <= 256 && timingSafeEqual(scryptSync(supplied, salt, 32), passwordHash);
      const validUser = typeof value.username === 'string' && value.username.length <= 64 && timingSafeEqual(hashUsername(value.username), usernameHash);
      if (!validPassword || !validUser) return json(res, 401, { code: 'invalid_login' });
      store.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
      if (Number(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n) >= 32) return json(res, 503, { code: 'session_limit' });
      const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
      store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), csrf, Date.now() + 8 * 3600000);
      store.audit('login');
      return json(res, 200, { csrf }, { 'Set-Cookie': `hc_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure ? '; Secure' : ''}` });
    }
    if (path.startsWith('/api/admin/')) {
      const auth = session(req); if (!auth) return json(res, 401, { code: 'admin_required' });
      if (req.method !== 'GET' && (req.headers.origin !== origin || req.headers['x-csrf-token'] !== auth.csrf)) return json(res, 403, { code: 'csrf_failed' });
      if (path === '/api/admin/session' && req.method === 'GET') return json(res, 200, { csrf: auth.csrf });
      if (path === '/api/admin/settings') {
        if (req.method === 'GET') return json(res, 200, { waitingMinutes: waitingMinutes() });
        if (req.method === 'PUT') {
          const value = await body(req, 128);
          if (Object.keys(value).length !== 1 || !Number.isSafeInteger(value.waitingMinutes) || Number(value.waitingMinutes) < 1 || Number(value.waitingMinutes) > 1440) return json(res, 400, { code: 'bad_request' });
          putMetadata.run('waiting_minutes', String(value.waitingMinutes)); store.audit('waiting_timeout_changed');
          await expireWaitingRooms(); return json(res, 200, { waitingMinutes: waitingMinutes() });
        }
        return json(res, 405, { code: 'bad_request' }, { Allow: 'GET, PUT' });
      }
      if (path === '/api/admin/logout' && req.method === 'POST') {
        store.db.prepare('DELETE FROM sessions WHERE hash=?').run(auth.hash); store.audit('logout');
        // Authenticated admin sockets are revoked together with their HTTP session.
        for (const client of adminSockets) if (client.sessionHash === auth.hash) client.socket.ws.close(4001, 'admin_logged_out');
        return json(res, 200, { ok: true }, { 'Set-Cookie': `hc_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}` });
      }
      if (path === '/api/admin/rooms' && req.method === 'GET') {
        await expireWaitingRooms();
        const page = Math.max(1, Math.min(100000, Number(url.searchParams.get('page')) || 1));
        const rows = store.db.prepare('SELECT id,created_at,phase,ply FROM rooms ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?').all((Math.floor(page) - 1) * 50);
        return json(res, 200, { rooms: rows.map(row => ({ ...row, waitingExpiresAt: ['lobby', 'crown_select'].includes(String(row.phase)) ? Number(row.created_at) + waitingMinutes() * 60000 : null, connected: runtimeRooms.get(String(row.id))?.core.adminSnapshot()?.view.connected ?? { w: false, b: false } })), total: store.count(), page: Math.floor(page), pageSize: 50 });
      }
      const adminRoute = /^\/api\/admin\/rooms\/([A-Z2-9]{8})(?:\/(end|log|links))?$/.exec(path);
      if (adminRoute && pattern.test(adminRoute[1])) {
        const id = adminRoute[1]; if (!store.row(id)) return json(res, 404, { code: 'room_not_found' });
        const room = getRoom(id);
        if (req.method === 'POST' && adminRoute[2] === 'end') {
          await room.core.adminEnd(); store.audit('room_ended', id); return json(res, 200, { ok: true });
        }
        if (req.method === 'DELETE' && !adminRoute[2]) {
          await removeRoom(id);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'GET' && adminRoute[2] === 'links') {
          const state = JSON.parse(String(store.row(id)!.state)) as GameState, links = linksFor(state);
          return json(res, 200, { white: links.white, black: links.black });
        }
        if (req.method === 'GET' && adminRoute[2] === 'log') {
          return room.blockConcurrencyWhile(async () => {
            const snapshot = room.core.adminSnapshot()!; return json(res, 200, { type: 'log', events: snapshot.events, moves: snapshot.view.moves, crowns: snapshot.view.crowns });
          });
        }
      }
      return json(res, 404, { code: 'not_found' });
    }
    if (path === '/api/rooms') {
      if (req.method !== 'POST') return json(res, 405, { code: 'bad_request' }, { Allow: 'POST' });
      if (!creates.take(ip) || !globalCreates.take('all')) return json(res, 429, { code: 'rate_limited' }, { 'Retry-After': '600' });
      const value = await body(req, 128); if (Object.keys(value).length) return json(res, 400, { code: 'bad_request' });
      return await serializeAdmission(async () => {
        await expireWaitingRooms();
        if (store.count() >= maxRooms || store.bytes() >= integer('MAX_DATABASE_BYTES', 256 * 1024 * 1024) * 0.9) return json(res, 503, { code: 'room_limit' });
        let id: string; do { id = [...randomBytes(8)].map(byte => alphabet[byte % 32]).join(''); } while (store.row(id));
        const response = await getRoom(id).core.fetch(new Request('http://room/init', { method: 'POST', body: JSON.stringify({ roomId: id, tokens: { w: randomUUID(), b: randomUUID(), observer: randomUUID() } }) }));
        return json(res, 201, await response.json());
      });
    }
    const status = /^\/api\/rooms\/([A-Z2-9]{8})\/status$/.exec(path);
    if (status && pattern.test(status[1]) && req.method === 'GET') {
      await expireWaitingRooms();
      if (!store.row(status[1])) return json(res, 404, { code: 'room_not_found' });
      return json(res, 200, { exists: true });
    }
    const join = /^\/api\/rooms\/([^/]+)\/join$/.exec(path);
    if (join) {
      if (req.method !== 'POST') return json(res, 405, { code: 'bad_request' }, { Allow: 'POST' });
      const id = join[1].toUpperCase(); if (!pattern.test(id)) return json(res, 400, { code: 'invalid_room_number' });
      const value = await body(req, 128);
      if (Object.keys(value).some(key => key !== 'color') || ('color' in value && !['w', 'b'].includes(String(value.color)))) return json(res, 400, { code: 'bad_request' });
      await expireWaitingRooms();
      if (!store.row(id)) return json(res, 404, { code: 'room_not_found' });
      const response = await getRoom(id).core.fetch(new Request('http://room/join', { method: 'POST', body: JSON.stringify(value) }));
      return json(res, response.status, await response.json());
    }
    if (path.startsWith('/api/') || path.startsWith('/ws/')) return json(res, 404, { code: 'not_found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { code: 'bad_request' });
    const asset = assets.get(path === '/admin/watch' ? '/' : path === '/admin/' ? '/admin' : path);
    if (!asset) return json(res, 404, { code: 'not_found' });
    res.writeHead(200, { 'Content-Type': `${asset.type}; charset=utf-8`, 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : asset.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const bad = message === 'body_too_large' || message === 'bad_request' || error instanceof SyntaxError;
    if (!res.headersSent) json(res, bad ? 400 : 503, { code: bad ? 'bad_request' : 'server_busy' });
    else res.end();
    // Deliberately omit request bodies, token URLs and state from operational logs.
    if (!bad) console.error('Request failed:', message.replace(/[^a-zA-Z_ ]/g, '').slice(0, 60));
  }
});
server.headersTimeout = 10000; server.requestTimeout = 10000; server.keepAliveTimeout = 5000;
server.maxConnections = maxConnections + 64;
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
const adminSockets = new Set<{ socket: Socket; sessionHash: string; expires: number }>();
server.on('upgrade', (req, socket, head) => {
  const deny = (status: number) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
  try {
    const url = new URL(req.url ?? '/', origin), match = /^\/ws\/([A-Z2-9]{8})$/.exec(url.pathname);
    if (req.headers.host !== new URL(origin).host || !sameOrigin(req)) return deny(403);
    if (!match || !pattern.test(match[1]) || !store.row(match[1])) return deny(404);
    const row = store.db.prepare('SELECT phase,created_at FROM rooms WHERE id=?').get(match[1])!;
    if (['lobby', 'crown_select'].includes(String(row.phase)) && Number(row.created_at) + waitingMinutes() * 60000 <= Date.now()) return deny(410);
    if (!upgrades.take(clientIp(req, proxies)) || wss.clients.size >= maxConnections) return deny(429);
    const isAdmin = url.searchParams.get('admin') === '1', auth = isAdmin ? session(req) : null;
    if (isAdmin && (!auth || req.headers.origin !== origin)) return deny(401);
    const room = getRoom(match[1]);
    if (room.sockets.size >= 16 || (!isAdmin && room.core.pendingCount() >= 8)) return deny(429);
    wss.handleUpgrade(req, socket, head, ws => {
      const wrapped = new Socket(ws); room.sockets.add(wrapped);
      let alive = true, closed = false;
      const task = room.blockConcurrencyWhile(() => room.core.accept(wrapped, isAdmin));
      task.catch(() => ws.close(1013, 'server_busy'));
      const admin = auth ? { socket: wrapped, sessionHash: auth.hash, expires: Date.now() + 8 * 3600000 } : null;
      if (admin) adminSockets.add(admin);
      ws.on('pong', () => { alive = true; });
      const heartbeat = setInterval(() => {
        if (!alive) return ws.terminate(); alive = false; ws.ping();
        if (admin && !store.db.prepare('SELECT hash FROM sessions WHERE hash=? AND expires>?').get(admin.sessionHash, Date.now())) ws.close(4001, 'admin_expired');
      }, 30000); heartbeat.unref();
      ws.on('message', (data, binary) => {
        if (!messages.take(wrapped.id)) { ws.close(1008, 'rate_limited'); return; }
        const state = store.db.prepare('SELECT phase,created_at FROM rooms WHERE id=?').get(room.id);
        if (!state) { ws.close(4001, 'room_deleted'); return; }
        if (['lobby', 'crown_select'].includes(String(state.phase)) && Number(state.created_at) + waitingMinutes() * 60000 <= Date.now()) {
          removeRoom(room.id, true).catch(() => ws.close(1013, 'server_busy')); return;
        }
        room.core.webSocketMessage(wrapped, binary ? new ArrayBuffer(0) : data.toString()).catch(() => ws.close(1013, 'server_busy'));
      });
      ws.on('error', () => { /* Close reconciles room presence. */ });
      ws.on('close', code => {
        clearInterval(heartbeat); if (admin) adminSockets.delete(admin);
        if (closed) return; closed = true;
        room.core.webSocketClose(wrapped, code, '', code === 1000).catch(() => {}).finally(() => room.sockets.delete(wrapped));
      });
    });
  } catch { deny(503); }
});
server.listen(port, host, () => console.log(`Hidden Crown listening on ${host}:${port}; public origin ${origin}`));
const expiryTimer = setInterval(() => { expireWaitingRooms().catch(() => console.error('Waiting-room cleanup failed')); }, 5000);
expiryTimer.unref();
expireWaitingRooms().catch(() => console.error('Waiting-room cleanup failed'));
let stopping = false;
function shutdown() {
  if (stopping) return; stopping = true;
  clearInterval(expiryTimer);
  for (const ws of wss.clients) ws.close(1001, 'server_restart');
  server.close(() => { store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); store.db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
