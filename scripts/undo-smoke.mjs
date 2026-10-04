import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import WebSocket from 'ws';
import pg from 'pg';
const external = process.env.HIDDEN_CROWN_URL;
const base = external ?? 'http://127.0.0.1:8810';
const password = external ? process.env.HIDDEN_CROWN_ADMIN_PASSWORD : 'isolated-undo-test-password';
const username = external ? process.env.HIDDEN_CROWN_ADMIN_USERNAME ?? 'admin' : 'admin';
const directory = `test-artifacts/undo-${randomUUID()}`;
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
  child = spawn(process.execPath, ['dist/server.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '8810', PUBLIC_ORIGIN: base, DATABASE_URL: databaseUrl,
    DATABASE_PATH: `${directory}/test.sqlite`, ADMIN_USERNAME: username, ADMIN_PASSWORD: password,
    TRUSTED_PROXIES: '127.0.0.1', CREATE_LIMIT_PER_IP: '100', CREATE_LIMIT_GLOBAL: '100', MAX_COMPUTER_ROOMS: '6' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  for (let i = 0; i < 160; i++) { if (output.includes('listening on')) return; if (child.exitCode !== null) break; await pause(50); }
  throw new Error(`Undo test server startup failed: ${output}`);
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
    throw new Error(`Undo runtime timed out; phase=${frames.findLast(f => f.type === 'state')?.view.phase}`);
  }
  const client = { ws, frames, wait, get closed() { return closed; }, get view() { return frames.findLast(f => f.type === 'state')?.view; },
    action: async (message, predicate) => { const start = frames.length; ws.send(JSON.stringify(message)); return wait(predicate, start); } };
  await wait(f => f.type === 'state'); return client;
}
try {
  if (!external) {
    await mkdir(directory, { recursive: true });
    if (adminDb) {
      databaseName = `hc_undo_${randomUUID().replaceAll('-', '_')}`;
      const admin = new pg.Client({ connectionString: adminDb }); await admin.connect();
      try { await admin.query(`CREATE DATABASE ${databaseName}`); } finally { await admin.end(); }
      const url = new URL(adminDb); url.pathname = '/' + databaseName; databaseUrl = url.href;
    }
    await start();
  }
  const login = await request('/api/admin/login', 'POST', { username, password }); equal(login.status, 200);
  const asset = await fetch(base + '/js/turn-sound.js'); equal(asset.status, 200); check((await asset.text()).includes('createTurnSound'));
  auth = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: base }; mutate = { ...auth, 'X-CSRF-Token': login.data.csrf };
  const made = await request('/api/rooms', 'POST', {}); equal(made.status, 201);
  const room = made.data; ids.push(room.roomId);
  let white = await connect({ ...room, link: room.links.white }), black = await connect({ ...room, link: room.links.black });
  let god = await connect(room, true);
  await white.wait(f => f.type === 'state' && f.view.phase === 'crown_select');
  await white.action({ type: 'select_crown', pieceId: 'wK' }, f => f.type === 'state' && f.view.crownLocked.w);
  await black.action({ type: 'select_crown', pieceId: 'bK' }, f => f.type === 'state' && f.view.phase === 'playing');
  await white.wait(f => f.type === 'state' && f.view.phase === 'playing');
  const initial = structuredClone(white.view.board);
  await white.action({ type: 'move', from: 12, to: 28 }, f => f.type === 'state' && f.view.moves.length === 1);
  await black.wait(f => f.type === 'state' && f.view.moves.length === 1);
  await black.action({ type: 'move', from: 52, to: 36 }, f => f.type === 'state' && f.view.moves.length === 2);
  await white.wait(f => f.type === 'state' && f.view.moves.length === 2);
  await white.action({ type: 'request_undo' }, f => f.type === 'state' && f.view.undoRequest?.targetPly === 0);
  await black.wait(f => f.type === 'state' && !!f.view.undoRequest);
  equal(white.view.canRequestUndo, false); equal(white.view.legalMoves, []);
  equal((await white.action({ type: 'respond_undo', accept: true }, f => f.type === 'error')).code, 'no_opponent_undo');
  equal((await black.action({ type: 'move', from: 51, to: 35 }, f => f.type === 'error')).code, 'undo_pending');
  equal((await god.action({ type: 'respond_undo', accept: true }, f => f.type === 'error')).code, 'player_only');
  await black.action({ type: 'respond_undo', accept: false }, f => f.type === 'state' && !f.view.undoRequest);
  equal(black.view.moves.length, 2);
  await white.wait(f => f.type === 'state' && f.view.moves.length === 2 && !f.view.undoRequest);
  await white.action({ type: 'request_undo' }, f => f.type === 'state' && !!f.view.undoRequest);
  if (!external) {
    await stop(); await start();
    white = await connect({ ...room, link: room.links.white }); black = await connect({ ...room, link: room.links.black }); god = await connect(room, true);
    equal(black.view.undoRequest, { color: 'w', targetPly: 0 });
  } else await black.wait(f => f.type === 'state' && !!f.view.undoRequest);
  await black.action({ type: 'respond_undo', accept: true }, f => f.type === 'state' && !f.view.undoRequest && f.view.moves.length === 0);
  await white.wait(f => f.type === 'state' && !f.view.undoRequest && f.view.moves.length === 0);
  equal(white.view.board, initial); equal(white.view.turn, 'w'); equal(white.view.yourCrown, 'wK');
  check(white.view.turnStartedAt >= white.view.playStartedAt);
  const log = (await request(`/api/admin/rooms/${room.roomId}/log`, 'GET', undefined, auth)).data;
  equal(log.moves.length, 0); equal(log.events.filter(e => e.type === 'move').length, 2);
  equal(log.events.findLast(e => e.type === 'undo_accepted').data.removed.length, 2);
  await white.action({ type: 'move', from: 11, to: 27 }, f => f.type === 'state' && f.view.moves.length === 1);
  equal(white.view.moves[0].ply, 1); check(white.view.moves[0].thinkMs < 10000);
  await white.action({ type: 'request_undo' }, f => f.type === 'state' && !!f.view.undoRequest);
  equal((await request(`/api/admin/rooms/${room.roomId}/end`, 'POST', undefined, mutate)).status, 200);
  await white.wait(f => f.type === 'state' && f.view.phase === 'ended'); equal(white.view.undoRequest, null);
  equal((await white.action({ type: 'request_undo' }, f => f.type === 'error')).code, 'wrong_phase');
  for (const side of ['w', 'b']) {
    const created = await request('/api/rooms', 'POST', { computer: { humanColor: side, difficulty: 'hard' } }); equal(created.status, 201);
    const botRoom = created.data; ids.push(botRoom.roomId); const player = await connect(botRoom);
    await player.wait(f => f.type === 'state' && f.view.phase === 'crown_select');
    await player.action({ type: 'select_crown', pieceId: `${side}K` }, f => f.type === 'state' && f.view.crownLocked[side]);
    await player.wait(f => f.type === 'state' && f.view.phase === 'playing' && f.view.turn === side);
    const opening = player.view.moves.length;
    const makeMove = async () => { const m = player.view.legalMoves[0], n = player.view.moves.length; await player.action({ type: 'move', from: m.from, to: m.to, ...(m.promotion ? { promotion: m.promotion } : {}) }, f => f.type === 'state' && f.view.moves.length === n + 1); };
    await makeMove();
    await player.wait(f => f.type === 'state' && f.view.turn === side && f.view.moves.length === opening + 2);
    let cursor = player.frames.length;
    await player.action({ type: 'request_undo' }, f => f.type === 'state' && !!f.view.undoRequest);
    await player.wait(f => f.type === 'state' && !f.view.undoRequest && f.view.moves.length === opening, cursor);
    equal(player.view.turn, side); equal(player.view.yourCrown, `${side}K`);
    await makeMove();
    // Request before the delayed bot response; its pending move must be cancelled.
    cursor = player.frames.length;
    await player.action({ type: 'request_undo' }, f => f.type === 'state' && !!f.view.undoRequest);
    await player.wait(f => f.type === 'state' && !f.view.undoRequest && f.view.moves.length === opening, cursor);
    await pause(750); equal(player.view.moves.length, opening); equal(player.view.turn, side);
    for (const frame of player.frames.filter(f => f.type === 'state')) { check(!Object.hasOwn(frame.view, 'crowns')); check(!Object.hasOwn(frame.view, 'tokens')); }
    const audit = (await request(`/api/admin/rooms/${botRoom.roomId}/log`, 'GET', undefined, auth)).data;
    equal(audit.events.filter(e => e.type === 'undo_accepted').length, 2);
  }
  console.log(`Undo runtime passed: ${checks} assertions; ${external ? 'container' : adminDb ? 'PostgreSQL' : 'SQLite'}`);
} finally {
  for (const socket of sockets) socket.close();
  if (external && mutate) for (const id of ids) await request(`/api/admin/rooms/${id}`, 'DELETE', undefined, mutate).catch(() => {});
  await stop();
  if (databaseName) {
    const admin = new pg.Client({ connectionString: adminDb }); await admin.connect();
    try { await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`); } finally { await admin.end(); }
  }
}
