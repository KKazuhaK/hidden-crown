import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, randomInt, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { computerRequest, difficulties } from '../src/computer/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { GameState, LogEvent } from '../src/types';
import { Store } from './storage';
import { configuration, integer } from './config';
import { SqliteDatabase } from './database/sqlite';
import { PostgresDatabase } from './database/postgres';
import { RoomManager, Socket } from './runtime';
import { ruleRegistry } from '../src/rules/registry';
import { promisify } from 'node:util';
import { scrypt } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Limiter, clientIp, proxyInfo } from './security';
import { playerLinksFor, viewFor } from '../src/protocol';

async function main() {
const config = configuration();
const { port, host, origin, secure, password, username, proxies, maxRooms, maxConnections } = config;
const usernameHash = createHash('sha256').update(username).digest();
const hashUsername = (value: string) => createHash('sha256').update(value).digest();
const salt = randomBytes(16), passwordHash = scryptSync(password, salt, 32);
const hashPassword = promisify(scrypt);
const database = config.databaseUrl ? new PostgresDatabase(config.databaseUrl, config.poolSize) : new SqliteDatabase(config.databasePath, config.maxDatabaseBytes);
const store = new Store(database, config.maxRoomBytes);
const eventLoop = monitorEventLoopDelay({ resolution: 20 }); eventLoop.enable();
try {
  if (database instanceof PostgresDatabase) await database.acquireOwnership();
  await store.initialize();
} catch (error) {
  await store.close().catch(() => {});
  console.error(error instanceof Error && error.message === 'database_already_owned' ? 'This database is already owned by another application instance' : 'Database initialization failed; verify configuration and schema permissions');
  process.exit(1);
}
const authSalt = await store.metadata('auth_salt') ?? randomBytes(16).toString('hex');
const fingerprint = scryptSync(`${username}\0${password}`, authSalt, 32).toString('hex');
if (await store.metadata('auth_fingerprint') !== fingerprint) await store.revokeSessions();
await store.setMetadata('auth_salt', authSalt); await store.setMetadata('auth_fingerprint', fingerprint);
if (!await store.metadata('waiting_minutes')) await store.setMetadata('waiting_minutes', String(config.initialWait));
let waitingValue = Number(await store.metadata('waiting_minutes'));
const waitingMinutes = () => waitingValue;
const manager = new RoomManager(store, config, waitingMinutes), runtimeRooms = manager.rooms;
const getRoom = (id: string) => manager.get(id);
const removeRoom = (id: string, expired = false) => manager.remove(id, expired);
const expireWaitingRooms = () => manager.expire();
const requests = new Limiter(120, 60000), globalRequests = new Limiter(2000, 60000, 1);
const creates = new Limiter(integer('CREATE_LIMIT_PER_IP', 5), 600000);
const globalCreates = new Limiter(integer('CREATE_LIMIT_GLOBAL', 100), 600000, 1);
const loginAttempts = new Limiter(5, 900000), globalLogins = new Limiter(30, 900000, 1);
const upgrades = new Limiter(30, 60000), messages = new Limiter(30, 1000, maxConnections);
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', pattern = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const revokedSessions = new Map<string, number>();
let admission = Promise.resolve();
function serializeAdmission<T>(callback: () => Promise<T>): Promise<T> {
  const result = admission.then(callback); admission = result.then(() => {}, () => {}); return result;
}
function json(res: ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(data));
}
function limited(res: ServerResponse, limiter: Limiter, key: string, scope: string) {
  const retryAfter = limiter.retryAfter(key);
  return json(res, 429, { code: 'rate_limited', scope, retryAfter }, { 'Retry-After': String(retryAfter) });
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
async function session(req: IncomingMessage) {
  const cookie = /(?:^|;\s*)hc_admin=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '');
  if (!cookie) return null;
  if (revokedSessions.has(hash(cookie[1]))) return null;
  const row = await store.session(hash(cookie[1]));
  return row && !revokedSessions.has(row.hash) ? row : null;
}
function sameOrigin(req: IncomingMessage) { return !req.headers.origin || req.headers.origin === origin; }
const assets = new Map<string, { content: Buffer; type: string }>();
for (const [route, file, type] of [
  ['/', 'index.html', 'text/html'], ['/styles.css', 'styles.css', 'text/css'],
  ['/js/app.js', 'js/app.js', 'text/javascript'], ['/js/board.js', 'js/board.js', 'text/javascript'], ['/js/i18n.js', 'js/i18n.js', 'text/javascript'],
  ['/js/admin-i18n.js', 'js/admin-i18n.js', 'text/javascript'], ['/admin', 'admin.html', 'text/html'], ['/js/admin.js', 'js/admin.js', 'text/javascript'], ['/js/icons.js', 'js/icons.js', 'text/javascript'],
  ['/js/pieces.js', 'js/pieces.js', 'text/javascript'], ['/js/board-motion.js', 'js/board-motion.js', 'text/javascript'], ['/js/replay.js', 'js/replay.js', 'text/javascript'], ['/js/turn-sound.js', 'js/turn-sound.js', 'text/javascript'], ['/js/game-records.js', 'js/game-records.js', 'text/javascript']
]) assets.set(route, { content: readFileSync(fileURLToPath(new URL(`../public/${file}`, import.meta.url))), type });
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    const url = new URL(req.url ?? '/', origin), path = url.pathname;
    if (req.headers.host !== new URL(origin).host) return json(res, 403, { code: 'host_denied' });
    const ip = clientIp(req, proxies);
    if (!requests.take(ip)) return limited(res, requests, ip, 'requests');
    if (!globalRequests.take('all')) return limited(res, globalRequests, 'all', 'requests_global');
    if (!sameOrigin(req)) return json(res, 403, { code: 'origin_denied' });
    if (path === '/healthz' && req.method === 'GET') { await store.health(); return json(res, 200, { ok: true }); }
    if (path === '/api/rules' && req.method === 'GET') return json(res, 200, { rulesets: ruleRegistry.list(), computer: { difficulties } });
    if (path === '/api/admin/login') {
      if (req.method !== 'POST') return json(res, 405, { code: 'bad_request' }, { Allow: 'POST' });
      if (!loginAttempts.take(ip) || !globalLogins.take('all')) return json(res, 429, { code: 'rate_limited' }, { 'Retry-After': '900' });
      const value = await body(req);
      const supplied = typeof value.password === 'string' ? value.password : '';
      const validPassword = supplied.length <= 256 && timingSafeEqual(await hashPassword(supplied, salt, 32) as Buffer, passwordHash);
      const validUser = typeof value.username === 'string' && value.username.length <= 64 && timingSafeEqual(hashUsername(value.username), usernameHash);
      if (!validPassword || !validUser) return json(res, 401, { code: 'invalid_login' });
      const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
      for (const [key, until] of revokedSessions) if (until <= Date.now()) revokedSessions.delete(key);
      await store.addSession(hash(token), csrf, Date.now() + 8 * 3600000);
      return json(res, 200, { csrf }, { 'Set-Cookie': `hc_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure ? '; Secure' : ''}` });
    }
    if (path.startsWith('/api/admin/')) {
      const auth = await session(req); if (!auth) return json(res, 401, { code: 'admin_required' });
      if (req.method !== 'GET' && (req.headers.origin !== origin || req.headers['x-csrf-token'] !== auth.csrf)) return json(res, 403, { code: 'csrf_failed' });
      if (path === '/api/admin/session' && req.method === 'GET') return json(res, 200, { csrf: auth.csrf });
      if (path === '/api/admin/network' && req.method === 'GET') return json(res, 200, proxyInfo(req, proxies));
      if (path === '/api/admin/metrics' && req.method === 'GET') return json(res, 200, {
        database: database.kind, usage: await store.usage(), loadedRooms: runtimeRooms.size,
        connections: wss.clients.size, memoryRssBytes: process.memoryUsage().rss,
        eventLoopP95Ms: Math.round(eventLoop.percentile(95) / 10000) / 100,
        limits: { rooms: config.maxRooms, activeRooms: config.maxActiveRooms, computerRooms: config.maxComputerRooms, computerWorkers: config.computerWorkers, loadedRooms: config.maxLoadedRooms, connections: config.maxConnections, cacheBytes: config.maxCacheBytes, storedBytes: config.maxStoredBytes }
      });
      if (path === '/api/admin/settings') {
        if (req.method === 'GET') return json(res, 200, { waitingMinutes: waitingMinutes() });
        if (req.method === 'PUT') {
          const value = await body(req, 128);
          if (Object.keys(value).length !== 1 || !Number.isSafeInteger(value.waitingMinutes) || Number(value.waitingMinutes) < 1 || Number(value.waitingMinutes) > 1440) return json(res, 400, { code: 'bad_request' });
          await store.setMetadata('waiting_minutes', String(value.waitingMinutes)); waitingValue = Number(value.waitingMinutes); await store.audit('waiting_timeout_changed');
          await expireWaitingRooms(); return json(res, 200, { waitingMinutes: waitingMinutes() });
        }
        return json(res, 405, { code: 'bad_request' }, { Allow: 'GET, PUT' });
      }
      if (path === '/api/admin/logout' && req.method === 'POST') {
        revokedSessions.set(auth.hash, auth.expires);
        await store.deleteSession(auth.hash); await store.audit('logout');
        // Authenticated admin sockets are revoked together with their HTTP session.
        for (const client of adminSockets) if (client.sessionHash === auth.hash) client.socket.ws.close(4001, 'admin_logged_out');
        return json(res, 200, { ok: true }, { 'Set-Cookie': `hc_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}` });
      }
      if (path === '/api/admin/rooms' && req.method === 'GET') {
        await expireWaitingRooms();
        const page = Math.max(1, Math.min(100000, Number(url.searchParams.get('page')) || 1));
        const rows = await store.list(Math.floor(page));
        return json(res, 200, { rooms: rows.map(row => ({ ...row, waitingExpiresAt: ['lobby', 'crown_select'].includes(String(row.phase)) ? Number(row.created_at) + waitingMinutes() * 60000 : null, connected: runtimeRooms.get(String(row.id))?.core.adminSnapshot()?.view.connected ?? { w: row.computer_color === 'w', b: row.computer_color === 'b' } })), total: await store.count(), page: Math.floor(page), pageSize: 50 });
      }
      const adminRoute = /^\/api\/admin\/rooms\/([A-Z2-9]{8})(?:\/(end|log|links))?$/.exec(path);
      if (adminRoute && pattern.test(adminRoute[1])) {
        const id = adminRoute[1]; if (!await store.header(id)) return json(res, 404, { code: 'room_not_found' });
        if (req.method === 'POST' && adminRoute[2] === 'end') {
          const room = await getRoom(id);
          await room.core.adminEnd(); await store.audit('room_ended', id); return json(res, 200, { ok: true });
        }
        if (req.method === 'DELETE' && !adminRoute[2]) {
          await removeRoom(id);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'GET' && adminRoute[2] === 'links') {
          const state = (await store.load(id))!.state;
          return json(res, 200, playerLinksFor(state));
        }
        if (req.method === 'GET' && adminRoute[2] === 'log') {
          const room = runtimeRooms.get(id);
          if (!room) {
            const saved = (await store.load(id))!;
            const view = viewFor(saved.state, 'observer', { w: false, b: false });
            return json(res, 200, { type: 'log', events: saved.events, moves: view.moves, crowns: view.crowns });
          }
          await room.core.ready;
          return room.blockConcurrencyWhile(async () => {
            const snapshot = room.core.adminSnapshot()!; return json(res, 200, { type: 'log', events: snapshot.events, moves: snapshot.view.moves, crowns: snapshot.view.crowns });
          });
        }
      }
      return json(res, 404, { code: 'not_found' });
    }
    if (path === '/api/rooms') {
      if (req.method !== 'POST') return json(res, 405, { code: 'bad_request' }, { Allow: 'POST' });
      if (!creates.take(ip)) return limited(res, creates, ip, 'create_ip');
      if (!globalCreates.take('all')) return limited(res, globalCreates, 'all', 'create_global');
      const value = await body(req, 1024); if (Object.keys(value).some(key => !['ruleset', 'computer'].includes(key))) return json(res, 400, { code: 'bad_request' });
      const ruleset = ruleRegistry.selection(value.ruleset);
      const computer = 'computer' in value ? computerRequest(value.computer, ruleset, () => randomInt(2)) : undefined;
      return await serializeAdmission(async () => {
        await expireWaitingRooms();
        const usage = await store.usage();
        if (usage.rooms >= maxRooms || usage.active >= config.maxActiveRooms || usage.bytes >= config.maxStoredBytes) return json(res, 503, { code: 'room_limit' });
        if (computer && await store.computerCount() >= config.maxComputerRooms) return json(res, 503, { code: 'computer_limit' });
        let id: string; do { id = [...randomBytes(8)].map(byte => alphabet[byte % 32]).join(''); } while (await store.header(id));
        const response = await (await getRoom(id)).core.fetch(new Request('http://room/init', { method: 'POST', body: JSON.stringify({ roomId: id, ruleset, computer, tokens: { w: randomUUID(), b: randomUUID(), observer: randomUUID() } }) }));
        return json(res, 201, await response.json());
      });
    }
    const status = /^\/api\/rooms\/([A-Z2-9]{8})\/status$/.exec(path);
    if (status && pattern.test(status[1]) && req.method === 'GET') {
      await expireWaitingRooms();
      if (!await store.header(status[1])) return json(res, 404, { code: 'room_not_found' });
      return json(res, 200, { exists: true });
    }
    const join = /^\/api\/rooms\/([^/]+)\/join$/.exec(path);
    if (join) {
      if (req.method !== 'POST') return json(res, 405, { code: 'bad_request' }, { Allow: 'POST' });
      const id = join[1].toUpperCase(); if (!pattern.test(id)) return json(res, 400, { code: 'invalid_room_number' });
      const value = await body(req, 128);
      if (Object.keys(value).some(key => key !== 'color') || ('color' in value && !['w', 'b'].includes(String(value.color)))) return json(res, 400, { code: 'bad_request' });
      await expireWaitingRooms();
      if (!await store.header(id)) return json(res, 404, { code: 'room_not_found' });
      const response = await (await getRoom(id)).core.fetch(new Request('http://room/join', { method: 'POST', body: JSON.stringify(value) }));
      return json(res, response.status, await response.json());
    }
    if (path.startsWith('/api/') || path.startsWith('/ws/')) return json(res, 404, { code: 'not_found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { code: 'bad_request' });
    const asset = assets.get(['/admin/watch', '/create', '/rules'].includes(path) ? '/' : path === '/admin/' ? '/admin' : path);
    if (!asset) return json(res, 404, { code: 'not_found' });
    res.writeHead(200, { 'Content-Type': `${asset.type}; charset=utf-8`, 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : asset.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const bad = ['body_too_large', 'bad_request', 'invalid_ruleset', 'unsupported_ruleset', 'invalid_computer', 'computer_unavailable'].includes(message) || error instanceof SyntaxError;
    if (!res.headersSent) json(res, bad ? 400 : 503, { code: bad ? (['invalid_ruleset', 'unsupported_ruleset', 'invalid_computer', 'computer_unavailable'].includes(message) ? message : 'bad_request') : 'server_busy' });
    else res.end();
    // Deliberately omit request bodies, token URLs and state from operational logs.
    if (!bad) console.error('Request failed');
  }
});
server.headersTimeout = 10000; server.requestTimeout = 10000; server.keepAliveTimeout = 5000;
server.maxConnections = maxConnections + 64;
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
const adminSockets = new Set<{ socket: Socket; sessionHash: string; expires: number }>();
server.on('upgrade', async (req, socket, head) => {
  const deny = (status: number) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
  try {
    const url = new URL(req.url ?? '/', origin), match = /^\/ws\/([A-Z2-9]{8})$/.exec(url.pathname);
    if (req.headers.host !== new URL(origin).host || !sameOrigin(req)) return deny(403);
    if (!match || !pattern.test(match[1]) || !await store.header(match[1])) return deny(404);
    const row = (await store.header(match[1]))!;
    if (['lobby', 'crown_select'].includes(String(row.phase)) && Number(row.created_at) + waitingMinutes() * 60000 <= Date.now()) return deny(410);
    if (!upgrades.take(clientIp(req, proxies)) || wss.clients.size >= maxConnections) return deny(429);
    const isAdmin = url.searchParams.get('admin') === '1', auth = isAdmin ? await session(req) : null;
    if (isAdmin && (!auth || req.headers.origin !== origin)) return deny(401);
    const room = await getRoom(match[1]);
    if (auth && (auth.expires <= Date.now() || revokedSessions.has(auth.hash))) return deny(401);
    if (room.sockets.size >= 16 || (!isAdmin && room.core.pendingCount() >= 8)) return deny(429);
    if (socket.destroyed) return;
    if (wss.clients.size >= maxConnections || room.sockets.size >= 16) return deny(429);
    wss.handleUpgrade(req, socket, head, ws => {
      const wrapped = new Socket(ws); room.sockets.add(wrapped);
      let alive = true, closed = false;
      const task = room.blockConcurrencyWhile(async () => {
        if (auth && revokedSessions.has(auth.hash)) { ws.close(4001, 'admin_logged_out'); return; }
        await room.core.accept(wrapped, isAdmin);
      });
      task.catch(() => ws.close(1013, 'server_busy'));
      const admin = auth ? { socket: wrapped, sessionHash: auth.hash, expires: Date.now() + 8 * 3600000 } : null;
      if (admin) adminSockets.add(admin);
      ws.on('pong', () => { alive = true; });
      const heartbeat = setInterval(() => {
        if (!alive) return ws.terminate(); alive = false; ws.ping();
        if (admin) store.session(admin.sessionHash).then(auth => { if (!auth) ws.close(4001, 'admin_expired'); }).catch(() => ws.close(1013, 'server_busy'));
      }, 30000); heartbeat.unref();
      let inbound: Promise<unknown> = Promise.resolve(), inboundQueued = 0;
      ws.on('message', (data, binary) => {
        if (!messages.take(wrapped.id)) { ws.close(1008, 'rate_limited'); return; }
        if (inboundQueued >= 64) { ws.close(1013, 'room_busy'); return; }
        inboundQueued++;
        const task = inbound.then(async () => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const state = await store.header(room.id);
          if (!state) { ws.close(4001, 'room_deleted'); return; }
          if (['lobby', 'crown_select'].includes(state.phase) && state.created_at + waitingMinutes() * 60000 <= Date.now()) {
            await removeRoom(room.id, true); return;
          }
          await room.core.webSocketMessage(wrapped, binary ? new ArrayBuffer(0) : data.toString());
        });
        inbound = task.catch(() => ws.close(1013, 'server_busy')).finally(() => { inboundQueued--; });
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
  eventLoop.disable();
  for (const ws of wss.clients) ws.close(1001, 'server_restart');
  server.close(() => { (async () => { await manager.close(); await store.close(); process.exit(0); })().catch(() => { console.error('Shutdown failed'); process.exit(1); }); });
  setTimeout(() => { console.error('Shutdown timed out'); process.exit(1); }, 10000).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
main().catch(() => { console.error('Startup failed; verify environment configuration'); process.exit(1); });
