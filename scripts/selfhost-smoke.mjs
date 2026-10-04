import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import pg from 'pg';
const postgresAdmin = process.env.TEST_DATABASE_URL, createdDatabases = new Set();
const password = 'local-test-only-hidden-crown', username = 'researcher';
const sockets = [], children = [];
let checks = 0;
function equal(actual, expected) { assert.deepEqual(actual, expected); checks++; }
function check(value) { assert.ok(value); checks++; }
const directory = new URL(`../test-artifacts/selfhost-${randomUUID()}/`, import.meta.url);
await mkdir(directory, { recursive: true });
async function start(port, extra = {}, database = `test-artifacts/selfhost-${directory.pathname.split('/').at(-2)}/${port}.sqlite`) {
  const base = `http://127.0.0.1:${port}`;
  let databaseUrl = '';
  if (postgresAdmin) {
    database = `hc_smoke_${directory.pathname.split('/').at(-2).replaceAll('-', '_')}_${port}`;
    if (!createdDatabases.has(database)) { const admin = new pg.Client({ connectionString: postgresAdmin }); await admin.connect(); try { await admin.query(`CREATE DATABASE ${database}`); createdDatabases.add(database); } finally { await admin.end(); } }
    const url = new URL(postgresAdmin); url.pathname = '/' + database; databaseUrl = url.href;
  }
  const child = spawn(process.execPath, ['dist/server.mjs'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: base, DATABASE_PATH: database, DATABASE_URL: databaseUrl, ADMIN_USERNAME: username, ADMIN_PASSWORD: password, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (output.includes('listening on')) return { base, child, database, databaseUrl };
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Server did not start: ${output}`);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Shutdown timeout')), 12000).unref())]);
}
async function request(base, path, method = 'GET', body, headers = {}) {
  const response = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, headers: response.headers, data: await response.json() };
}
async function connect(base, room, role, adminHeaders, clientHeaders = {}) {
  const frames = [], ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/${room.roomId}${adminHeaders ? '?admin=1' : ''}`, { headers: adminHeaders ?? clientHeaders });
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
  equal((await request(base, '/api/rules')).data.rulesets[0].id, 'hidden-crown');
  equal((await request(base, '/api/rooms', 'POST', { ruleset: { id: 'hidden-crown', version: 999 } })).data.code, 'unsupported_ruleset');
  equal((await request(base, '/api/rooms', 'POST', { ruleset: { id: 'hidden-crown', version: 1, options: { invalid: true } } })).status, 400);
  equal((await request(base, '/api/admin/rooms')).status, 401);
  equal((await request(base, '/api/admin/session')).status, 401);
  equal((await request(base, '/api/admin/login', 'POST', { username: 'wrong', password })).status, 401);
  equal((await request(base, '/api/admin/login', 'POST', { username, password: 'wrong' })).status, 401);
  const login = await request(base, '/api/admin/login', 'POST', { username, password }); equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = login.data.csrf;
  check(login.headers.get('set-cookie').includes('HttpOnly')); check(login.headers.get('set-cookie').includes('SameSite=Strict'));
  const auth = { Cookie: cookie }, mutate = { ...auth, Origin: base, 'X-CSRF-Token': csrf };
  equal((await request(base, '/api/admin/metrics')).status, 401);
  equal((await request(base, '/api/admin/metrics', 'GET', undefined, auth)).data.database, postgresAdmin ? 'postgres' : 'sqlite');
  if (postgresAdmin) {
    const duplicate = spawn(process.execPath, ['dist/server.mjs'], { env: { ...process.env, PORT: '8805', PUBLIC_ORIGIN: 'http://127.0.0.1:8805', DATABASE_URL: server.databaseUrl, ADMIN_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(duplicate); let diagnostic = ''; duplicate.stderr.on('data', data => diagnostic += data);
    await new Promise(resolve => duplicate.once('exit', resolve));
    equal(duplicate.exitCode, 1); check(diagnostic.includes('already owned')); check(!diagnostic.includes(password));
  }
  equal((await request(base, '/api/admin/settings')).status, 401);
  equal((await request(base, '/api/admin/settings', 'GET', undefined, auth)).data.waitingMinutes, 15);
  equal((await request(base, '/api/admin/settings', 'PUT', { waitingMinutes: 30 }, auth)).status, 403);
  for (const value of [0, 1441, 1.5, '15']) equal((await request(base, '/api/admin/settings', 'PUT', { waitingMinutes: value }, mutate)).status, 400);
  equal((await request(base, '/api/admin/settings', 'PUT', { waitingMinutes: 30 }, mutate)).data.waitingMinutes, 30);
  equal((await request(base, '/api/admin/settings', 'PUT', { waitingMinutes: 15 }, mutate)).data.waitingMinutes, 15);
  const room = (await request(base, '/api/rooms', 'POST')).data;
  equal((await request(base, `/api/admin/rooms/${room.roomId}/links`)).status, 401);
  equal((await request(base, `/api/admin/rooms/${room.roomId}/links`, 'GET', undefined, auth)).data, room.links);
  equal(Object.keys(room.links).sort(), ['black', 'white']);
  // Even a leaked legacy observer token must not grant the public god view.
  let legacyToken;
  if (postgresAdmin) {
    const fixtureDb = new pg.Client({ connectionString: server.databaseUrl }); await fixtureDb.connect();
    try { legacyToken = JSON.parse((await fixtureDb.query('SELECT state FROM hc_rooms WHERE id=$1', [room.roomId])).rows[0].state).tokens.observer; }
    finally { await fixtureDb.end(); }
  } else {
    const fixtureDb = new DatabaseSync(server.database);
    legacyToken = JSON.parse(fixtureDb.prepare('SELECT state FROM hc_rooms WHERE id=?').get(room.roomId).state).tokens.observer;
    fixtureDb.close();
  }
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
  const staleLobby = (await request(base, '/api/rooms', 'POST')).data;
  const staleWhite = await connect(base, staleLobby, 'white');
  const staleCrowns = (await request(base, '/api/rooms', 'POST')).data;
  const expiredCrownWhite = await connect(base, staleCrowns, 'white'), expiredCrownBlack = await connect(base, staleCrowns, 'black');
  const preserved = (await request(base, '/api/rooms', 'POST')).data;
  await request(base, `/api/admin/rooms/${preserved.roomId}/end`, 'POST', undefined, mutate);
  const oldAt = Date.now() - 16 * 60000;
  if (postgresAdmin) {
    const ageDb = new pg.Client({ connectionString: server.databaseUrl }); await ageDb.connect();
    try { for (const id of [staleLobby.roomId, staleCrowns.roomId, room.roomId, preserved.roomId]) await ageDb.query('UPDATE hc_rooms SET created_at=$1 WHERE id=$2', [oldAt, id]); } finally { await ageDb.end(); }
  } else {
    const ageDb = new DatabaseSync(server.database);
    for (const id of [staleLobby.roomId, staleCrowns.roomId, room.roomId, preserved.roomId]) ageDb.prepare('UPDATE hc_rooms SET created_at=? WHERE id=?').run(oldAt, id);
    ageDb.close();
  }
  expiredCrownWhite.ws.send(JSON.stringify({ type: 'select_crown', pieceId: 'wK' }));
  expiredCrownBlack.ws.send(JSON.stringify({ type: 'select_crown', pieceId: 'bK' }));
  // The periodic sweep must run even without an HTTP request or cached-room load.
  const expiryDeadline = Date.now() + 6500;
  while (staleWhite.closed === null && Date.now() < expiryDeadline) await new Promise(resolve => setTimeout(resolve, 30));
  equal(staleWhite.closed, 4001);
  equal((await request(base, `/api/rooms/${staleLobby.roomId}/join`, 'POST')).status, 404);
  equal((await request(base, `/api/rooms/${staleLobby.roomId}/status`)).status, 404);
  equal((await request(base, `/api/rooms/${room.roomId}/status`)).data, { exists: true });
  equal((await request(base, `/api/rooms/${staleCrowns.roomId}/join`, 'POST')).status, 404);
  equal(await upgradeStatus(base, staleLobby), 404);
  equal((await request(base, `/api/admin/rooms/${room.roomId}/log`, 'GET', undefined, auth)).data.moves.length, 1);
  equal((await request(base, `/api/admin/rooms/${preserved.roomId}/log`, 'GET', undefined, auth)).status, 200);
  await request(base, `/api/admin/rooms/${preserved.roomId}`, 'DELETE', undefined, mutate);
  equal((await request(base, '/api/admin/settings', 'PUT', { waitingMinutes: 30 }, mutate)).status, 200);
  const pending = (await request(base, '/api/rooms', 'POST')).data;
  const first = await request(base, `/api/rooms/${pending.roomId}/join`, 'POST', { color: 'w' }); equal(first.data.role, 'w');
  for (const ws of sockets) ws.close(); await stop(server.child);
  server = await start(8791, { CREATE_LIMIT_PER_IP: '100', CREATE_LIMIT_GLOBAL: '200' }, server.database);
  equal((await request(base, '/api/admin/session', 'GET', undefined, auth)).status, 200);
  equal((await request(base, '/api/admin/settings', 'GET', undefined, auth)).data.waitingMinutes, 30);
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
  const throttled = await request(limits.base, '/api/rooms', 'POST');
  equal(throttled.status, 429); equal(throttled.data.scope, 'create_ip');
  check(throttled.data.retryAfter > 0 && throttled.data.retryAfter <= 300);
  equal(throttled.headers.get('retry-after'), String(throttled.data.retryAfter));
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
  const many = await start(8803, { CREATE_LIMIT_PER_IP: '100', CREATE_LIMIT_GLOBAL: '100', MAX_LOADED_ROOMS: '80', TRUSTED_PROXIES: '127.0.0.1' });
  for (let index = 0; index < 70; index++) {
    const created = await request(many.base, '/api/rooms', 'POST'); equal(created.status, 201);
    await connect(many.base, created.data, 'white', undefined, { 'X-Forwarded-For': `198.18.0.${index + 1}` });
  }
  equal((await request(many.base, '/healthz')).status, 200);
  const manyLogin = await request(many.base, '/api/admin/login', 'POST', { username, password });
  const manyMetrics = await request(many.base, '/api/admin/metrics', 'GET', undefined, { Cookie: manyLogin.headers.get('set-cookie').split(';')[0] });
  equal(manyMetrics.data.loadedRooms, 70); equal(manyMetrics.data.connections, 70);
  await writeFile(new URL('result.json', directory), JSON.stringify({ checks, passed: true, at: new Date().toISOString() }));
  console.log(`PASS: ${checks} self-host assertions: authentication, CSRF, admin live views/moderation, persistence, creation/login/message/connection limits and proxy spoof rejection.`);
} finally {
  for (const ws of sockets) ws.close();
  for (const child of children) await stop(child);
  if (postgresAdmin) {
    const admin = new pg.Client({ connectionString: postgresAdmin }); await admin.connect();
    try { for (const name of createdDatabases) await admin.query(`DROP DATABASE ${name}`); } finally { await admin.end(); }
  }
}
