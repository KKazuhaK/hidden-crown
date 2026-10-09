import { recordsCsv } from '../public/js/game-records.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import WebSocket from 'ws';
import pg from 'pg';
const external = process.env.HIDDEN_CROWN_URL;
const base = external ?? 'http://127.0.0.1:8813';
const password = external ? process.env.HIDDEN_CROWN_ADMIN_PASSWORD : 'isolated-standard-chess-test-password';
const username = external ? process.env.HIDDEN_CROWN_ADMIN_USERNAME ?? 'admin' : 'admin';
const directory = `test-artifacts/standard-chess-${randomUUID()}`;
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
  child = spawn(process.execPath, ['dist/server.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '8813', PUBLIC_ORIGIN: base, DATABASE_URL: databaseUrl,
    DATABASE_PATH: `${directory}/test.sqlite`, ADMIN_USERNAME: username, ADMIN_PASSWORD: password,
    TRUSTED_PROXIES: '127.0.0.1', CREATE_LIMIT_PER_IP: '100', CREATE_LIMIT_GLOBAL: '100', MAX_COMPUTER_ROOMS: '6' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  for (let i = 0; i < 160; i++) { if (output.includes('listening on')) return; if (child.exitCode !== null) break; await pause(50); }
  throw new Error(`Standard chess test server startup failed: ${output}`);
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
    throw new Error(`Standard chess runtime timed out; phase=${frames.findLast(f => f.type === 'state')?.view.phase}`);
  }
  const client = { ws, frames, wait, get closed() { return closed; }, get view() { return frames.findLast(f => f.type === 'state')?.view; },
    action: async (message, predicate) => { const start = frames.length; ws.send(JSON.stringify(message)); return wait(predicate, start); } };
  await wait(f => f.type === 'state'); return client;
}
try {
  if (!external) {
    await mkdir(directory, { recursive: true });
    if (adminDb) {
      databaseName = `hc_standard_${randomUUID().replaceAll('-', '_')}`;
      const admin = new pg.Client({ connectionString: adminDb }); await admin.connect();
      try { await admin.query(`CREATE DATABASE ${databaseName}`); } finally { await admin.end(); }
      const url = new URL(adminDb); url.pathname = '/' + databaseName; databaseUrl = url.href;
    }
    await start();
  }
  const login = await request('/api/admin/login', 'POST', { username, password }); equal(login.status, 200);
  auth = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: base }; mutate = { ...auth, 'X-CSRF-Token': login.data.csrf };

  const state = predicate => f => f.type === 'state' && predicate(f.view);
  const error = code => f => f.type === 'error' && f.code === code;
  const selection = { id: 'standard-chess', version: 1 };
  const made = await request('/api/rooms', 'POST', { ruleset: selection }); equal(made.status, 201);
  const room = made.data; ids.push(room.roomId);
  let white = await connect({ ...room, link: room.links.white }); equal(white.view.phase, 'lobby');
  let black = await connect({ ...room, link: room.links.black }), god = await connect(room, true);
  await white.wait(state(v => v.phase === 'playing')); equal(black.view.phase, 'playing');
  equal(white.view.ruleset.id, 'standard-chess'); equal(white.view.crownLocked, { w: false, b: false });
  equal(white.view.legalMoves.length, 20); equal(white.view.undoEnabled, false);
  check(!white.view.interrogationsRemaining); check(white.view.playStartedAt > 0);
  await white.action({ type: 'select_crown', pieceId: 'wQ' }, error('unsupported_action')); checks++;
  await white.action({ type: 'interrogate', targetId: 'bQ' }, error('unsupported_action')); checks++;
  await white.action({ type: 'request_undo' }, error('undo_disabled')); checks++;
  await white.action({ type: 'rule_action', action: 'claim_draw', payload: {} }, error('invalid_draw_claim')); checks++;
  await black.action({ type: 'move', from: 52, to: 36 }, error('not_your_turn')); checks++;
  let ply = 0;
  async function move(client, from, to) {
    ply++; await client.action({ type: 'move', from, to }, state(v => v.moves.length === ply));
    await god.wait(state(v => v.moves.length === ply));
  }
  await move(white, 13, 21); await black.wait(state(v => v.moves.length === 1));
  await move(black, 52, 36); await white.wait(state(v => v.moves.length === 2));
  if (!external) {
    for (const socket of sockets) socket.close(); await pause(150); await stop(); await start();
    const loggedIn = await request('/api/admin/login', 'POST', { username, password }); equal(loggedIn.status, 200);
    auth = { Cookie: loggedIn.headers.get('set-cookie').split(';')[0], Origin: base }; mutate = { ...auth, 'X-CSRF-Token': loggedIn.data.csrf };
    white = await connect({ ...room, link: room.links.white }); black = await connect({ ...room, link: room.links.black }); god = await connect(room, true);
    equal(white.view.moves.map(m => m.notation), ['f3','e5']); equal(white.view.phase, 'playing');
  }
  await move(white, 14, 30); await black.wait(state(v => v.moves.length === 3));
  await move(black, 59, 31); await white.wait(state(v => v.phase === 'ended'));
  equal(white.view.result, { winner: 'b', reason: 'checkmate' }); equal(white.view.moves.at(-1).notation, 'Qh4#');
  equal(white.view.pieces.wK.square, 4); equal(white.view.crowns, { w: null, b: null });
  equal((await request(`/api/admin/rooms/${room.roomId}/log`)).status, 401);
  const exported = await request(`/api/admin/rooms/${room.roomId}/log`, 'GET', undefined, auth); equal(exported.status, 200);
  equal(exported.data.moves.length, 4); check(exported.data.events.some(e => e.type === 'game_ended' && e.data.reason === 'checkmate'));
  check(recordsCsv(exported.data.moves).includes('Qh4#')); check(exported.data.events.some(e => e.type === 'room_created' && e.data.ruleset.id === 'standard-chess'));
  // Repetition counting survives reconnect and storage reload, including intended-move claims.
  const repeated = (await request('/api/rooms', 'POST', { ruleset: selection })).data; ids.push(repeated.roomId);
  white = await connect({ ...repeated, link: repeated.links.white }); black = await connect({ ...repeated, link: repeated.links.black });
  await white.wait(state(v => v.phase === 'playing'));
  const cycle = [[6,21],[62,45],[21,6],[45,62]];
  for (let i = 0; i < 7; i++) {
    const actor = i % 2 ? black : white, other = i % 2 ? white : black;
    await actor.action({ type: 'move', from: cycle[i % 4][0], to: cycle[i % 4][1] }, state(v => v.moves.length === i + 1));
    await other.wait(state(v => v.moves.length === i + 1));
  }
  equal(black.view.drawClaim.reason, 'threefold_repetition'); equal(black.view.drawClaim.move.to, 62);
  if (!external) {
    for (const socket of sockets) socket.close(); await pause(150); await stop(); await start();
    black = await connect({ ...repeated, link: repeated.links.black });
    equal(black.view.drawClaim.reason, 'threefold_repetition');
  }
  await black.action({ type: 'rule_action', action: 'claim_draw', payload: { from: 45, to: 62 } }, state(v => v.phase === 'ended'));
  equal(black.view.result.reason, 'threefold_repetition'); equal(black.view.moves.length, 7);
  for (const difficulty of ['easy','medium','hard']) for (const humanColor of ['w','b']) {
    const created = await request('/api/rooms', 'POST', { ruleset: selection, computer: { humanColor, difficulty } }); equal(created.status, 201);
    ids.push(created.data.roomId); const human = await connect(created.data);
    await human.wait(state(v => v.phase === 'playing')); equal(human.view.crownLocked, { w: false, b: false });
    await human.wait(state(v => v.turn === humanColor && v.legalMoves?.length));
    await human.action({ type: 'offer_draw' }, error('computer_draw_offer_disabled')); checks++;
    await human.action({ type: 'respond_draw', accept: true }, error('computer_draw_offer_disabled')); checks++;
    equal(human.view.drawOffer, null);
    if (humanColor === 'b') equal(human.view.moves[0].color, 'w');
    const legal = human.view.legalMoves[0], before = human.view.moves.length;
    await human.action({ type: 'move', from: legal.from, to: legal.to }, state(v => v.moves.length >= before + 1));
    await human.wait(state(v => v.moves.length >= before + 2 && v.turn === humanColor));
    check(human.view.moves.every(m => m.kind !== 'interrogation')); check(human.view.pieces.wK.square !== null && human.view.pieces.bK.square !== null);
    await human.action({ type: 'resign' }, state(v => v.phase === 'ended')); human.ws.close();
  }
  const hidden = (await request('/api/rooms', 'POST', {})).data; ids.push(hidden.roomId);
  white = await connect({ ...hidden, link: hidden.links.white }); black = await connect({ ...hidden, link: hidden.links.black });
  await white.wait(state(v => v.phase === 'crown_select')); equal(white.view.ruleset.id, 'hidden-crown'); equal(white.view.ruleset.version, 5);
  console.log(`Standard chess runtime passed: ${checks} assertions; ${external ? 'container' : adminDb ? 'PostgreSQL' : 'SQLite'}`);
} finally {
  for (const socket of sockets) socket.close();
  if (external && mutate) for (const id of ids) await request(`/api/admin/rooms/${id}`, 'DELETE', undefined, mutate).catch(() => {});
  await stop();
  if (databaseName) {
    const admin = new pg.Client({ connectionString: adminDb }); await admin.connect();
    try { await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`); } finally { await admin.end(); }
  }
}
