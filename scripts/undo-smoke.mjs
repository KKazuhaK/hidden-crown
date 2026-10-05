import { recordsCsv } from '../public/js/game-records.js';
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
  const rules = (await request('/api/rules')).data.rulesets;
  equal(rules.filter(r => r.id === 'hidden-crown').map(r => r.version), [4]);
  for (const version of [1, 2, 3]) {
    const retired = await request('/api/rooms', 'POST', { ruleset: { id: 'hidden-crown', version } });
    equal(retired.status, 400); equal(retired.data.code, 'unsupported_ruleset');
    equal((await request('/api/rooms', 'POST', { ruleset: { id: 'hidden-crown', version }, computer: { humanColor: 'w', difficulty: 'easy' } })).status, 400);
  }
  const made = await request('/api/rooms', 'POST', {}); equal(made.status, 201);
  const room = made.data; ids.push(room.roomId);
  // Confirm authenticated exports before exercising either player identity.
  const preflight = await request(`/api/admin/rooms/${room.roomId}/log`, 'GET', undefined, auth);
  equal(preflight.status, 200); check(Array.isArray(preflight.data.events));
  check(recordsCsv(preflight.data.moves).startsWith('ply,color,notation'));
  equal((await request(`/api/admin/rooms/${room.roomId}/log`)).status, 401);
  let white = await connect({ ...room, link: room.links.white }), black = await connect({ ...room, link: room.links.black });
  let god = await connect(room, true);
  await white.wait(f => f.type === 'state' && f.view.phase === 'crown_select');
  const denied = async client => {
    equal(client.view.ruleset.version, 4); equal(client.view.undoEnabled, false); equal(client.view.canRequestUndo, false);
    const before = structuredClone(client.view);
    for (const message of [{ type: 'request_undo' }, { type: 'respond_undo', accept: true }, { type: 'respond_undo', accept: false }])
      equal((await client.action(message, f => f.type === 'error')).code, 'undo_disabled');
    equal(client.view, before); check(!client.view.undoRequest);
  };
  await denied(white); await denied(black);
  await white.action({ type: 'select_crown', pieceId: 'wQ' }, f => f.type === 'state' && f.view.crownLocked.w);
  await black.action({ type: 'select_crown', pieceId: 'bQ' }, f => f.type === 'state' && f.view.phase === 'playing');
  await white.wait(f => f.type === 'state' && f.view.phase === 'playing');
  let ply = 0;
  async function move(client, from, to) {
    ply++; await client.action({ type: 'move', from, to }, f => f.type === 'state' && f.view.moves.length === ply);
    for (const peer of [white, black, god]) await peer.wait(f => f.type === 'state' && f.view.moves.length === ply);
  }
  await move(white, 12, 28); await denied(white);
  await move(black, 51, 35); await move(white, 28, 35);
  await move(black, 58, 37); await move(white, 3, 12);
  await move(black, 37, 19); await move(white, 12, 19); // Capture the original bishop, revealing it is not the crown.
  equal(white.view.moves.at(-1).captured, 'bBc'); equal(white.view.phase, 'playing');
  await denied(white); await denied(black);
  equal((await god.action({ type: 'request_undo' }, f => f.type === 'error')).code, 'player_only');
  const beforeRestart = structuredClone(white.view);
  const log = (await request(`/api/admin/rooms/${room.roomId}/log`, 'GET', undefined, auth)).data;
  equal(log.moves.length, ply); check(!log.events.some(e => e.type.startsWith('undo_')));
  check(recordsCsv(log.moves).includes('bBc'));
  if (!external) {
    for (const socket of sockets) socket.close(); await pause(100); await stop(); await start();
    white = await connect({ ...room, link: room.links.white }); black = await connect({ ...room, link: room.links.black }); god = await connect(room, true);
    equal(white.view.board, beforeRestart.board); equal(white.view.moves, beforeRestart.moves);
    await denied(white);
  }
  await move(black, 52, 36); // A rejected undo never freezes the opponent's next turn.
  await white.action({ type: 'resign' }, f => f.type === 'state' && f.view.phase === 'ended');
  await denied(white);
  for (const side of ['w', 'b']) {
    const created = await request('/api/rooms', 'POST', { computer: { humanColor: side, difficulty: 'hard' } }); equal(created.status, 201);
    const botRoom = created.data; ids.push(botRoom.roomId); const player = await connect(botRoom);
    await player.wait(f => f.type === 'state' && f.view.phase === 'crown_select');
    await player.action({ type: 'select_crown', pieceId: `${side}Q` }, f => f.type === 'state' && f.view.crownLocked[side]);
    await player.wait(f => f.type === 'state' && f.view.phase === 'playing' && f.view.turn === side);
    const opening = player.view.moves.length;
    await denied(player);
    const m = player.view.legalMoves[0];
    await player.action({ type: 'move', from: m.from, to: m.to, ...(m.promotion ? { promotion: m.promotion } : {}) }, f => f.type === 'state' && f.view.moves.length === opening + 1);
    await denied(player); // Rejection also holds while the bot is thinking.
    await player.wait(f => f.type === 'state' && f.view.turn === side && f.view.moves.length === opening + 2);
    await denied(player);
    for (const frame of player.frames.filter(f => f.type === 'state')) { check(!Object.hasOwn(frame.view, 'crowns')); check(!Object.hasOwn(frame.view, 'tokens')); }
    const audit = (await request(`/api/admin/rooms/${botRoom.roomId}/log`, 'GET', undefined, auth)).data;
    check(!audit.events.some(e => e.type.startsWith('undo_')));
  }
  console.log(`Undo-disabled runtime passed: ${checks} assertions; ${external ? 'container' : adminDb ? 'PostgreSQL' : 'SQLite'}`);
} finally {
  for (const socket of sockets) socket.close();
  if (external && mutate) for (const id of ids) await request(`/api/admin/rooms/${id}`, 'DELETE', undefined, mutate).catch(() => {});
  await stop();
  if (databaseName) {
    const admin = new pg.Client({ connectionString: adminDb }); await admin.connect();
    try { await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`); } finally { await admin.end(); }
  }
}
