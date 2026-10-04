import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
const password = 'local-test-only-hidden-crown', username = 'researcher';
const sockets = [], children = [];
let checks = 0;
function equal(actual, expected) { assert.deepEqual(actual, expected); checks++; }
function check(value) { assert.ok(value); checks++; }
const directory = new URL(`../test-artifacts/selfhost-${randomUUID()}/`, import.meta.url);
await mkdir(directory, { recursive: true });
async function start(port, extra = {}, database = `test-artifacts/selfhost-${directory.pathname.split('/').at(-2)}/${port}.sqlite`) {
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist/server.mjs'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: base, DATABASE_PATH: database, ADMIN_USERNAME: username, ADMIN_PASSWORD: password, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (output.includes('listening on')) return { base, child, database };
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Server did not start: ${output}`);
}
async function stop(child) {
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Shutdown timeout')), 12000).unref())]);
}
async function request(base, path, method = 'GET', body, headers = {}) {
  const response = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, headers: response.headers, data: await response.json() };
}
async function connect(base, room, role, adminHeaders) {
  const frames = [], ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/${room.roomId}${adminHeaders ? '?admin=1' : ''}`, { headers: adminHeaders ?? {} });
  sockets.push(ws); let closed = null;
  ws.on('error', () => {}); ws.on('close', code => closed = code); ws.on('message', data => frames.push(JSON.parse(data)));
  if (!adminHeaders) ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: new URL(room.links[role], base).hash.slice(3) })));
  async function wait(predicate, start = 0) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { const frame = frames.slice(start).find(predicate); if (frame) return frame; await new Promise(resolve => setTimeout(resolve, 15)); }
    throw new Error(`WebSocket timeout ${role}: ${JSON.stringify(frames.at(-1))}`);
  }
  async function action(message, predicate) { const start = frames.length; ws.send(JSON.stringify(message)); return wait(predicate, start); }
  await wait(frame => frame.type === 'welcome'); await wait(frame => frame.type === 'state');
  return { ws, frames, wait, action, get closed() { return closed; }, get view() { return frames.findLast(frame => frame.type === 'state').view; } };
}
async function upgradeStatus(base, room, headers = {}, admin = false) {
  return new Promise(resolve => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/${room.roomId}${admin ? '?admin=1' : ''}`, { headers });
    ws.on('unexpected-response', (_, response) => { response.resume(); resolve(response.statusCode); });
    ws.on('error', () => {}); ws.on('open', () => { ws.close(); resolve(101); });
  });
}
try {
  let server = await start(8791, { CREATE_LIMIT_PER_IP: '100', CREATE_LIMIT_GLOBAL: '200' });
  const base = server.base;
  equal((await request(base, '/api/admin/rooms')).status, 401);
  equal((await request(base, '/api/admin/login', 'POST', { username: 'wrong', password })).status, 401);
  equal((await request(base, '/api/admin/login', 'POST', { username, password: 'wrong' })).status, 401);
  const login = await request(base, '/api/admin/login', 'POST', { username, password }); equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = login.data.csrf;
  check(login.headers.get('set-cookie').includes('HttpOnly')); check(login.headers.get('set-cookie').includes('SameSite=Strict'));
  const auth = { Cookie: cookie }, mutate = { ...auth, Origin: base, 'X-CSRF-Token': csrf };
  const room = (await request(base, '/api/rooms', 'POST')).data;
  equal(Object.keys(room.links).sort(), ['black', 'white']);
  // Even a leaked legacy observer token must not grant the public god view.
  const fixtureDb = new DatabaseSync(server.database);
  const legacyToken = JSON.parse(fixtureDb.prepare('SELECT state FROM rooms WHERE id=?').get(room.roomId).state).tokens.observer;
  fixtureDb.close();
  const publicObserver = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/${room.roomId}`);
  sockets.push(publicObserver);
  const legacyClosed = new Promise(resolve => publicObserver.once('close', resolve));
  publicObserver.on('error', () => {});
  publicObserver.once('open', () => publicObserver.send(JSON.stringify({ type: 'hello', token: legacyToken })));
  equal(await legacyClosed, 4001);
  equal((await request(base, `/api/rooms/${room.roomId}/join`, 'POST')).data.code, 'choose_side');
  equal((await request(base, `/api/rooms/${room.roomId}/join`, 'POST', { color: 'b' })).data.role, 'b');
  equal((await request(base, `/api/rooms/${room.roomId}/join`, 'POST', { color: 'b' })).data.role, 'w');
  equal((await request(base, `/api/admin/rooms/${room.roomId}/end`, 'POST', undefined, auth)).status, 403);
  equal((await request(base, `/api/admin/rooms/${room.roomId}/end`, 'POST', undefined, { ...mutate, Origin: 'https://attacker.invalid' })).status, 403);
  equal(await upgradeStatus(base, room, {}, true), 401);
  equal(await upgradeStatus(base, room, { ...auth, Origin: 'https://attacker.invalid' }, true), 403);
  equal(await upgradeStatus(base, room, { Origin: 'https://attacker.invalid' }), 403);
  const white = await connect(base, room, 'white'), black = await connect(base, room, 'black'), observer = await connect(base, room, 'observer', { ...auth, Origin: base });
  await white.wait(frame => frame.type === 'state' && frame.view.phase === 'crown_select');
  const god = await connect(base, room, 'observer', { ...auth, Origin: base });
  equal(observer.closed, null); equal(god.view.role, 'observer');
  await white.action({ type: 'select_crown', pieceId: 'wK' }, frame => frame.type === 'state' && frame.view.crownLocked.w);
  await black.action({ type: 'select_crown', pieceId: 'bQ' }, frame => frame.type === 'state' && frame.view.phase === 'playing');
  await god.wait(frame => frame.type === 'state' && frame.view.phase === 'playing');
  equal(god.view.crowns, { w: 'wK', b: 'bQ' }); equal(Object.hasOwn(white.view, 'crowns'), false);
  equal((await god.action({ type: 'resign' }, frame => frame.type === 'error')).code, 'player_only');
  await white.action({ type: 'move', from: 12, to: 28 }, frame => frame.type === 'state' && frame.view.moves.length === 1);
  await god.wait(frame => frame.type === 'state' && frame.view.moves.length === 1);
  equal(god.view.board[28], 'wPe');
  const list = await request(base, '/api/admin/rooms', 'GET', undefined, auth); equal(list.data.total, 1); equal(list.data.rooms[0].connected, { w: true, b: true });
  check(!JSON.stringify(list.data).includes('tokens')); check(!JSON.stringify(list.data).includes('crowns'));
  const pending = (await request(base, '/api/rooms', 'POST')).data;
  const first = await request(base, `/api/rooms/${pending.roomId}/join`, 'POST', { color: 'w' }); equal(first.data.role, 'w');
  for (const ws of sockets) ws.close(); await stop(server.child);
  server = await start(8791, { CREATE_LIMIT_PER_IP: '100', CREATE_LIMIT_GLOBAL: '200' }, server.database);
  equal((await request(base, '/api/admin/session', 'GET', undefined, auth)).status, 200);
  equal((await request(base, `/api/rooms/${pending.roomId}/join`, 'POST')).data.role, 'b');
  const restored = await request(base, `/api/admin/rooms/${room.roomId}/log`, 'GET', undefined, auth);
  equal(restored.data.crowns, { w: 'wK', b: 'bQ' }); equal(restored.data.moves.length, 1); check(!JSON.stringify(restored.data).includes(new URL(room.links.white, base).hash.slice(3)));
  const recoveredWhite = await connect(base, room, 'white'), recoveredGod = await connect(base, room, 'observer', { ...auth, Origin: base });
  equal((await request(base, `/api/admin/rooms/${room.roomId}/end`, 'POST', undefined, mutate)).status, 200);
  await recoveredWhite.wait(frame => frame.type === 'state' && frame.view.phase === 'ended');
  equal(recoveredWhite.view.result.reason, 'admin'); equal(recoveredWhite.view.crowns, { w: 'wK', b: 'bQ' });
  const endedLog = await request(base, `/api/admin/rooms/${room.roomId}/log`, 'GET', undefined, auth);
  equal(endedLog.data.events.at(-1).actor, 'admin');
  equal((await request(base, `/api/admin/rooms/${room.roomId}`, 'DELETE', undefined, auth)).status, 403);
  equal((await request(base, `/api/admin/rooms/${room.roomId}`, 'DELETE', undefined, mutate)).status, 200);
  equal((await request(base, `/api/admin/rooms/${room.roomId}/log`, 'GET', undefined, auth)).status, 404);
  equal(await upgradeStatus(base, room), 404);
  // A queued close handler must never recreate a deleted room.
  equal((await request(base, '/api/admin/rooms', 'GET', undefined, auth)).data.total, 1);
  const pendingGod = await connect(base, pending, 'observer', { ...auth, Origin: base });
  equal((await request(base, '/api/admin/logout', 'POST', undefined, mutate)).status, 200);
  equal((await request(base, '/api/admin/rooms', 'GET', undefined, auth)).status, 401);
  await new Promise(resolve => setTimeout(resolve, 30)); equal(pendingGod.closed, 4001);
  await stop(server.child);
  const limits = await start(8792, { CREATE_LIMIT_PER_IP: '2', CREATE_LIMIT_GLOBAL: '100', MAX_ROOMS: '100' });
  equal((await request(limits.base, '/api/rooms', 'POST')).status, 201);
  equal((await request(limits.base, '/api/rooms', 'POST')).status, 201);
  equal((await request(limits.base, '/api/rooms', 'POST')).status, 429);
  equal((await request(limits.base, '/api/rooms', 'POST', undefined, { 'X-Forwarded-For': '1.2.3.4' })).status, 429);
  equal((await request(limits.base, '/api/rooms', 'POST', undefined, { Origin: 'https://attacker.invalid' })).status, 403);
  for (let i = 0; i < 5; i++) equal((await request(limits.base, '/api/admin/login', 'POST', { username, password: 'wrong' })).status, 401);
  equal((await request(limits.base, '/api/admin/login', 'POST', { username, password })).status, 429);
  const capped = await start(8793, { CREATE_LIMIT_PER_IP: '100', CREATE_LIMIT_GLOBAL: '100', MAX_ROOMS: '2', MAX_CONNECTIONS: '2' });
  const capacityRoom = (await request(capped.base, '/api/rooms', 'POST')).data;
  equal((await request(capped.base, '/api/rooms', 'POST')).status, 201);
  equal((await request(capped.base, '/api/rooms', 'POST')).status, 503);
  const cwhite = await connect(capped.base, capacityRoom, 'white'); await connect(capped.base, capacityRoom, 'black');
  equal(await upgradeStatus(capped.base, capacityRoom), 429);
  for (let i = 0; i < 40; i++) if (cwhite.ws.readyState === WebSocket.OPEN) cwhite.ws.send(JSON.stringify({ type: 'ping' }));
  await new Promise(resolve => setTimeout(resolve, 100)); equal(cwhite.closed, 1008);
  equal((await request(capped.base, '/healthz')).status, 200);
  await writeFile(new URL('result.json', directory), JSON.stringify({ checks, passed: true, at: new Date().toISOString() }));
  console.log(`PASS: ${checks} self-host assertions: authentication, CSRF, admin live views/moderation, persistence, creation/login/message/connection limits and proxy spoof rejection.`);
} finally { for (const ws of sockets) ws.close(); for (const child of children) if (child.exitCode === null) child.kill('SIGTERM'); }
