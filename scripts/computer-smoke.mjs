import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import WebSocket from 'ws';
import pg from 'pg';
const external = process.env.HIDDEN_CROWN_URL;
const base = external ?? 'http://127.0.0.1:8806';
const password = external ? process.env.HIDDEN_CROWN_ADMIN_PASSWORD : 'isolated-computer-test-password';
const username = external ? process.env.HIDDEN_CROWN_ADMIN_USERNAME ?? 'admin' : 'admin';
const directory = `test-artifacts/computer-${randomUUID()}`;
const adminDb = !external && process.env.TEST_DATABASE_URL;
let databaseUrl = '', databaseName, child, auth, mutate, checks = 0;
const sockets = [], ids = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const equal = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const check = value => { assert.ok(value); checks++; };
async function request(path, method = 'GET', value, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...headers, ...(value ? { 'Content-Type': 'application/json' } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) });
  return { status: res.status, headers: res.headers, data: await res.json() };
}
async function start() {
  child = spawn(process.execPath, ['dist/server.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '8806', PUBLIC_ORIGIN: base, DATABASE_URL: databaseUrl,
    DATABASE_PATH: `${directory}/test.sqlite`, ADMIN_USERNAME: username, ADMIN_PASSWORD: password,
    TRUSTED_PROXIES: '127.0.0.1', CREATE_LIMIT_PER_IP: '100', CREATE_LIMIT_GLOBAL: '100', MAX_COMPUTER_ROOMS: '6' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  for (let i = 0; i < 160; i++) { if (output.includes('listening on')) return; if (child.exitCode !== null) break; await pause(50); }
  throw new Error(`Computer test server startup failed: ${output}`);
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Shutdown timeout')), 12000).unref())]);
}
async function connect(room, admin = false) {
  const frames = [], ws = new WebSocket(base.replace(/^http/, 'ws') + `/ws/${room.roomId}${admin ? '?admin=1' : ''}`, admin ? { headers: auth } : {});
  sockets.push(ws); let closed;
  ws.on('error', () => {}); ws.on('message', raw => frames.push(JSON.parse(raw))); ws.on('close', code => { closed = code; });
  ws.on('open', () => { if (!admin) ws.send(JSON.stringify({ type: 'hello', token: new URL(room.link, base).hash.slice(3) })); });
  async function wait(predicate, start = 0) {
    for (let i = 0; i < 400; i++) { const frame = frames.slice(start).find(predicate); if (frame) return frame; await pause(25); }
    throw new Error(`Computer runtime timed out; phase=${frames.findLast(f => f.type === 'state')?.view.phase}`);
  }
  const client = { ws, frames, wait, get closed() { return closed; }, get view() { return frames.findLast(f => f.type === 'state')?.view; },
    action: async (message, predicate) => { const start = frames.length; ws.send(JSON.stringify(message)); return wait(predicate, start); } };
  await wait(f => f.type === 'state'); return client;
}
try {
  if (!external) {
    await mkdir(directory, { recursive: true });
    if (adminDb) {
      databaseName = `hc_computer_${randomUUID().replaceAll('-', '_')}`;
      const admin = new pg.Client({ connectionString: adminDb }); await admin.connect();
      try { await admin.query(`CREATE DATABASE ${databaseName}`); } finally { await admin.end(); }
      const url = new URL(adminDb); url.pathname = '/' + databaseName; databaseUrl = url.href;
    }
    await start();
  }
  const login = await request('/api/admin/login', 'POST', { username, password }); equal(login.status, 200);
  auth = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: base }; mutate = { ...auth, 'X-CSRF-Token': login.data.csrf };
  equal((await request('/api/admin/network')).status, 401);
  const net = (await request('/api/admin/network', 'GET', undefined, { ...auth, 'X-Forwarded-For': '198.51.100.7' })).data;
  if (!external) { equal(net.clientIp, '198.51.100.7'); equal(net.forwardedAccepted, true); }
  equal((await request('/api/rules')).data.computer.difficulties, ['easy', 'medium', 'hard']);
  equal((await request('/api/rooms', 'POST', { computer: { humanColor: 'w', difficulty: 'invalid' } })).data.code, 'invalid_computer');
  let saved, resumed;
  for (const difficulty of ['easy', 'medium', 'hard']) for (const humanColor of ['w', 'b']) {
    const created = await request('/api/rooms', 'POST', { computer: { humanColor, difficulty } }); equal(created.status, 201);
    const room = created.data; ids.push(room.roomId); saved = room;
    const role = humanColor === 'w' ? 'white' : 'black'; equal(Object.keys(room.links), [role]); equal(room.role, humanColor);
    equal((await request(`/api/rooms/${room.roomId}/join`, 'POST', { color: humanColor })).data.code, 'room_full');
    equal((await request(`/api/admin/rooms/${room.roomId}/links`, 'GET', undefined, auth)).data, room.links);
    const human = await connect(room); resumed = human;
    await human.wait(f => f.type === 'state' && f.view.phase === 'crown_select');
    await human.action({ type: 'select_crown', pieceId: `${humanColor}K` }, f => f.type === 'state' && f.view.crownLocked[humanColor]);
    await human.wait(f => f.type === 'state' && f.view.phase === 'playing');
    await human.wait(f => f.type === 'state' && f.view.turn === humanColor && f.view.legalMoves?.length);
    const before = human.view.moves.length, move = human.view.legalMoves[0];
    await human.action({ type: 'move', from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) }, f => f.type === 'state' && f.view.moves.length > before);
    await human.wait(f => f.type === 'state' && f.view.moves.length === before + 2 && f.view.turn === humanColor);
    check(human.frames.every(f => f.type !== 'error'));
    for (const frame of human.frames.filter(f => f.type === 'state')) { check(!Object.hasOwn(frame.view, 'crowns')); check(!Object.hasOwn(frame.view, 'tokens')); }
    await human.action({ type: 'offer_draw' }, f => f.type === 'state' && f.view.drawOffer === humanColor);
    await human.wait(f => f.type === 'state' && f.view.moves.length === before + 2 && !f.view.drawOffer);
    // An offline human must pause subsequent bot moves, including pending timers.
    const second = human.view.legalMoves[0];
    await human.action({ type: 'move', from: second.from, to: second.to }, f => f.type === 'state' && f.view.moves.length === before + 3);
    human.ws.close(); for (let i = 0; i < 100 && human.closed === undefined; i++) await pause(20);
    await pause(700);
    equal((await request(`/api/admin/rooms/${room.roomId}/log`, 'GET', undefined, auth)).data.moves.length, before + 3);
  }
  if (!external) {
    equal((await request('/api/rooms', 'POST', { computer: { humanColor: 'w', difficulty: 'easy' } })).data.code, 'computer_limit');
    await stop(); await start();
    equal((await request('/api/admin/session', 'GET', undefined, auth)).status, 200);
  }
  const human = await connect(saved); const before = resumed.view.moves.length;
  await human.wait(f => f.type === 'state' && f.view.moves.length === before + 1 && f.view.turn === saved.role);
  const god = await connect(saved, true); check(!!god.view.crowns.w && !!god.view.crowns.b);
  // End and delete while a bot is about to move, without allowing delayed writes.
  const m = human.view.legalMoves[0];
  await human.action({ type: 'move', from: m.from, to: m.to }, f => f.type === 'state' && f.view.moves.length === before + 2);
  equal((await request(`/api/admin/rooms/${saved.roomId}/end`, 'POST', undefined, mutate)).status, 200);
  await human.wait(f => f.type === 'state' && f.view.phase === 'ended'); equal(human.view.result.reason, 'admin');
  await pause(700); equal((await request(`/api/admin/rooms/${saved.roomId}/log`, 'GET', undefined, auth)).data.moves.length, before + 2);
  equal((await request(`/api/admin/rooms/${saved.roomId}`, 'DELETE', undefined, mutate)).status, 200);
  await pause(600); equal((await request(`/api/rooms/${saved.roomId}/status`)).status, 404);
  console.log(`Computer runtime passed: ${checks} assertions; ${external ? 'container' : adminDb ? 'PostgreSQL' : 'SQLite'}`);
} finally {
  for (const socket of sockets) socket.close();
  if (external && mutate) for (const id of ids) await request(`/api/admin/rooms/${id}`, 'DELETE', undefined, mutate).catch(() => {});
  await stop();
  if (databaseName) {
    const admin = new pg.Client({ connectionString: adminDb }); await admin.connect();
    try { await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`); } finally { await admin.end(); }
  }
}
