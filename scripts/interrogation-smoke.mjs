import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import WebSocket from 'ws';
import pg from 'pg';
const external = process.env.HIDDEN_CROWN_URL;
const base = external ?? 'http://127.0.0.1:8811';
const password = external ? process.env.HIDDEN_CROWN_ADMIN_PASSWORD : 'isolated-interrogation-test-password';
const username = external ? process.env.HIDDEN_CROWN_ADMIN_USERNAME ?? 'admin' : 'admin';
const directory = `test-artifacts/interrogation-${randomUUID()}`;
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
  child = spawn(process.execPath, ['dist/server.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '8811', PUBLIC_ORIGIN: base, DATABASE_URL: databaseUrl,
    DATABASE_PATH: `${directory}/test.sqlite`, ADMIN_USERNAME: username, ADMIN_PASSWORD: password,
    TRUSTED_PROXIES: '127.0.0.1', CREATE_LIMIT_PER_IP: '100', CREATE_LIMIT_GLOBAL: '100', MAX_COMPUTER_ROOMS: '6' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  for (let i = 0; i < 160; i++) { if (output.includes('listening on')) return; if (child.exitCode !== null) break; await pause(50); }
  throw new Error(`Interrogation test server startup failed: ${output}`);
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
    throw new Error(`Interrogation runtime timed out; phase=${frames.findLast(f => f.type === 'state')?.view.phase}`);
  }
  const client = { ws, frames, wait, get closed() { return closed; }, get view() { return frames.findLast(f => f.type === 'state')?.view; },
    action: async (message, predicate) => { const start = frames.length; ws.send(JSON.stringify(message)); return wait(predicate, start); } };
  await wait(f => f.type === 'state'); return client;
}
try {
  if (!external) {
    await mkdir(directory, { recursive: true });
    if (adminDb) {
      databaseName = `hc_interrogation_${randomUUID().replaceAll('-', '_')}`;
      const admin = new pg.Client({ connectionString: adminDb }); await admin.connect();
      try { await admin.query(`CREATE DATABASE ${databaseName}`); } finally { await admin.end(); }
      const url = new URL(adminDb); url.pathname = '/' + databaseName; databaseUrl = url.href;
    }
    await start();
  }
  const login = await request('/api/admin/login', 'POST', { username, password }); equal(login.status, 200);
  auth = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: base }; mutate = { ...auth, 'X-CSRF-Token': login.data.csrf };
  equal((await fetch(base + '/js/game-records.js')).status, 200);
  const made = await request('/api/rooms', 'POST'); equal(made.status, 201); const room = made.data; ids.push(room.roomId);
  let white = await connect({ ...room, link: room.links.white }), black = await connect({ ...room, link: room.links.black }), god = await connect(room, true);
  const state = predicate => f => f.type === 'state' && predicate(f.view);
  const error = code => f => f.type === 'error' && f.code === code;
  await white.wait(state(v => v.phase === 'crown_select'));
  await white.action({ type: 'select_crown', pieceId: 'wQ' }, error('invalid_crown')); checks++;
  await black.action({ type: 'select_crown', pieceId: 'bQ' }, error('invalid_crown')); checks++;
  await white.action({ type: 'select_crown', pieceId: 'wK' }, state(v => v.crownLocked.w));
  await black.action({ type: 'select_crown', pieceId: 'bBc' }, state(v => v.phase === 'playing'));
  await white.wait(state(v => v.phase === 'playing')); equal(white.view.ruleset.version, 2);
  let ply = 0;
  async function move(client, from, to) { ply++; await client.action({ type: 'move', from, to }, state(v => v.moves.length === ply)); await god.wait(state(v => v.moves.length === ply)); }
  // e2-e4, a7-a6, Qd1-h5, a6-a5. h5-c8 is NOT aligned; h5-e8 is.
  await move(white, 12, 28); await black.wait(state(v => v.moves.length === 1));
  await move(black, 48, 40); await white.wait(state(v => v.moves.length === 2));
  await move(white, 3, 39); await black.wait(state(v => v.moves.length === 3));
  await move(black, 40, 32); await white.wait(state(v => v.moves.length === 4));
  check(white.view.interrogationTargets.includes('bK'));
  await white.action({ type: 'interrogate', targetId: 'bK', answer: 'crown' }, error('bad_message')); checks++;
  const beforeBoard = [...white.view.board];
  ply++;
  await white.action({ type: 'interrogate', targetId: 'bK' }, state(v => v.moves.length === ply));
  await black.wait(state(v => v.moves.length === ply)); await god.wait(state(v => v.moves.length === ply));
  equal(white.view.board, beforeBoard); equal(white.view.turn, 'b'); equal(white.view.phase, 'playing');
  equal(white.view.moves.at(-1).answer, 'clear'); equal(god.view.moves.at(-1).answer, 'clear');
  check(!Object.hasOwn(black.view.moves.at(-1), 'answer')); equal(white.view.interrogationsRemaining, { w: 1, b: 2 });
  equal(white.view.canRequestUndo, false); equal(black.view.canRequestUndo, false);
  await white.action({ type: 'move', from: 28, to: 36 }, error('not_your_turn')); checks++;
  await white.action({ type: 'request_undo' }, error('undo_unavailable')); checks++;
  await god.action({ type: 'interrogate', targetId: 'bK' }, error('player_only')); checks++;
  await black.action({ type: 'get_log' }, error('observer_only')); checks++;
  const log = await request(`/api/admin/rooms/${room.roomId}/log`, 'GET', undefined, auth);
  equal(log.data.moves.at(-1).answer, 'clear'); equal(log.data.events.find(e => e.type === 'interrogation').data.targetId, 'bK');
  if (!external) {
  for (const socket of sockets) socket.close(); await pause(150); await stop(); await start();
    white = await connect({ ...room, link: room.links.white }); black = await connect({ ...room, link: room.links.black }); god = await connect(room, true);
    equal(white.view.moves.at(-1).answer, 'clear'); check(!Object.hasOwn(black.view.moves.at(-1), 'answer'));
    equal(white.view.interrogationsRemaining.w, 1);
  }
  await move(black, 49, 41); await white.wait(state(v => v.moves.length === 6));
  check(!white.view.interrogationTargets.includes('bK'));
  await white.action({ type: 'interrogate', targetId: 'bK' }, error('invalid_interrogation')); checks++;
  // Qh5-f5 aligns with Bc8 through e6 and d7, then interrogates the chosen original bishop.
  await move(white, 39, 37); await black.wait(state(v => v.moves.length === 7));
  await move(black, 41, 33); await white.wait(state(v => v.moves.length === 8));
  check(white.view.interrogationTargets.includes('bBc'));
  ply++; await white.action({ type: 'interrogate', targetId: 'bBc' }, state(v => v.moves.length === ply));
  await black.wait(state(v => v.moves.length === 9)); await god.wait(state(v => v.moves.length === 9));
  equal(white.view.moves.at(-1).answer, 'crown'); equal(god.view.moves.at(-1).answer, 'crown');
  check(!Object.hasOwn(black.view.moves.at(-1), 'answer')); equal(white.view.interrogationsRemaining.w, 0); equal(white.view.phase, 'playing');
  await move(black, 50, 42); await white.wait(state(v => v.moves.length === 10));
  equal(white.view.interrogationTargets, []);
  await white.action({ type: 'interrogate', targetId: 'bK' }, error('invalid_interrogation')); checks++;
  // The black pawn on d7 blocks a queen capture of the identified bishop; no win on interrogation.
  await white.action({ type: 'resign' }, state(v => v.phase === 'ended')); await black.wait(state(v => v.phase === 'ended'));
  check(white.view.moves.filter(m => m.kind === 'interrogation').every(m => m.answer));
  check(black.view.moves.filter(m => m.kind === 'interrogation').every(m => !Object.hasOwn(m, 'answer')));
  console.log(`Interrogation runtime passed: ${checks} assertions; ${external ? 'container' : adminDb ? 'PostgreSQL' : 'SQLite'}`);
} finally {
  for (const socket of sockets) socket.close();
  if (external && mutate) for (const id of ids) await request(`/api/admin/rooms/${id}`, 'DELETE', undefined, mutate).catch(() => {});
  await stop();
  if (databaseName) {
    const admin = new pg.Client({ connectionString: adminDb }); await admin.connect();
    try { await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`); } finally { await admin.end(); }
  }
}
