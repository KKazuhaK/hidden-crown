// Exercises the actual self-hosted HTTP/WebSocket runtime, not a mock room.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { adminHeaders } from './admin-test-auth.mjs';
const base = process.env.HIDDEN_CROWN_URL ?? 'http://127.0.0.1:8787';
const admin = await adminHeaders(base);
const sq = name => 'abcdefgh'.indexOf(name[0]) + (Number(name[1]) - 1) * 8;
const clients = [];
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks++; }
async function create() {
  const response = await fetch(`${base}/api/rooms`, { method: 'POST' });
  assert.equal(response.status, 201); const room = await response.json();
  check(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(room.roomId), 'room id format'); return room;
}
class Client {
  constructor(room, role, tokenOverride) {
    this.role = role; this.frames = []; this.closed = null;
    this.ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/${room.roomId}${role === 'observer' ? '?admin=1' : ''}`, role === 'observer' ? { headers: admin } : {});
    this.ws.addEventListener('message', event => this.frames.push(JSON.parse(event.data)));
    this.ws.addEventListener('close', event => { this.closed = event.code; });
    this.ws.addEventListener('open', () => { if (role !== 'observer') this.send({ type: 'hello', token: tokenOverride ?? new URL(room.links[role], base).hash.slice(3) }); });
    clients.push(this);
  }
  send(message) { this.ws.send(JSON.stringify(message)); }
  get view() { return this.frames.findLast(f => f.type === 'state')?.view; }
  async wait(predicate, description = 'frame', start = 0) {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const match = this.frames.slice(start).find(predicate); if (match) return match;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error(`Timed out: ${this.role} ${description}; last=${JSON.stringify(this.frames.at(-1))}`);
  }
  async action(message, predicate, description) {
    const start = this.frames.length; this.send(message); return this.wait(predicate, description, start);
  }
  async error(message, code) {
    const result = await this.action(message, f => f.type === 'error', code);
    assert.equal(result.code, code); checks++;
  }
  async close() {
    if (this.closed !== null) return;
    this.ws.close(); const deadline = Date.now() + 3000;
    while (this.closed === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 15));
  }
}
async function join(room, role) {
  const client = new Client(room, role); await client.wait(f => f.type === 'welcome'); await client.wait(f => f.type === 'state'); return client;
}
async function playing(wc = 'wK', bc = 'bK') {
  const room = await create(); const white = await join(room, 'white'), black = await join(room, 'black'), observer = await join(room, 'observer');
  await white.wait(f => f.type === 'state' && f.view.phase === 'crown_select');
  await white.action({ type: 'select_crown', pieceId: wc }, f => f.type === 'state' && f.view.crownLocked.w);
  await black.action({ type: 'select_crown', pieceId: bc }, f => f.type === 'state' && f.view.phase === 'playing');
  await observer.wait(f => f.type === 'state' && f.view.phase === 'playing');
  return { room, white, black, observer };
}
function privacy(client) {
  const color = client.role === 'white' ? 'w' : 'b';
  for (const frame of client.frames) {
    check(!['log', 'links'].includes(frame.type), 'no privileged payload to player');
    if (frame.type !== 'state') continue;
    check(!Object.hasOwn(frame.view, 'tokens'), 'tokens removed');
    if (frame.view.phase !== 'ended') check(!Object.hasOwn(frame.view, 'crowns'), 'opponent crown mapping absent');
    if (frame.view.yourCrown) check(frame.view.yourCrown.startsWith(color), 'only own crown');
    if (frame.view.phase === 'playing') check(Object.hasOwn(frame.view, 'legalMoves') === (frame.view.turn === color), 'moves only for current player');
  }
}
async function move(player, watcher, from, to) {
  const ply = player.view.moves.length + 1;
  const start = Date.now();
  const pending = watcher.wait(f => f.type === 'state' && f.view.moves.length === ply);
  await player.action({ type: 'move', from: sq(from), to: sq(to) }, f => f.type === 'state' && f.view.moves.length === ply);
  await pending;
  check(Date.now() - start < 1000, 'local move propagated in under one second');
}
try {
  const room = await create(); const white = await join(room, 'white');
  check(white.view.phase === 'lobby', 'wait for both players');
  await white.error({ type: 'resign' }, 'wrong_phase');
  const observer = await join(room, 'observer');
  check(observer.view.phase === 'lobby', 'observer does not advance lobby');
  await observer.error({ type: 'select_crown', pieceId: 'wK' }, 'player_only');
  await white.error({ type: 'get_links' }, 'observer_only'); await white.error({ type: 'get_log' }, 'observer_only');
  const links = await observer.action({ type: 'get_links' }, f => f.type === 'links');
  assert.deepEqual({ white: links.links.white, black: links.links.black }, room.links); checks++;
  const black = await join(room, 'black'); await white.wait(f => f.type === 'state' && f.view.phase === 'crown_select');
  await white.error({ type: 'select_crown', pieceId: 'wPa' }, 'invalid_crown');
  await white.error({ type: 'select_crown', pieceId: 'bQ' }, 'invalid_crown');
  await white.action({ type: 'select_crown', pieceId: 'wK' }, f => f.type === 'state' && f.view.crownLocked.w);
  check(white.view.phase === 'crown_select', 'one crown does not start play');
  await white.error({ type: 'select_crown', pieceId: 'wQ' }, 'invalid_crown');
  await black.action({ type: 'select_crown', pieceId: 'bPe' }, f => f.type === 'error');
  await black.action({ type: 'select_crown', pieceId: 'bPf' }, f => f.type === 'error');
  await black.action({ type: 'select_crown', pieceId: 'bQ' }, f => f.type === 'state' && f.view.phase === 'playing');
  await white.wait(f => f.type === 'state' && f.view.phase === 'playing');
  await white.error({ type: 'move', from: sq('e2'), to: sq('e5') }, 'illegal_move');
  await black.error({ type: 'move', from: sq('e7'), to: sq('e5') }, 'not_your_turn');
  await white.error({ type: 'move', from: 12, to: 28, castle: 'K' }, 'bad_message');
  await white.error({ type: 'hello', token: 'anything' }, 'already_authenticated');
  await white.action({ type: 'ping' }, f => f.type === 'pong'); checks++;
  await move(white, observer, 'e2', 'e4');
  await white.close(); await observer.wait(f => f.type === 'state' && !f.view.connected.w);
  const reopened = await join(room, 'white'); check(reopened.view.board[sq('e4')] === 'wPe', 'reconnect restores position');
  const replacement = await join(room, 'white');
  const deadline = Date.now() + 3000; while (reopened.closed === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 15));
  check(reopened.closed === 4000, 'second role socket replaces first');
  await replacement.error({ type: 'move', from: sq('d2'), to: sq('d4') }, 'not_your_turn');
  check(replacement.view.connected.w, 'old close does not disconnect replacement');
  await black.action({ type: 'offer_draw' }, f => f.type === 'state' && f.view.drawOffer === 'b');
  await black.error({ type: 'respond_draw', accept: true }, 'no_opponent_offer');
  await replacement.action({ type: 'respond_draw', accept: false }, f => f.type === 'state' && !f.view.drawOffer);
  await replacement.error({ type: 'respond_draw', accept: true }, 'no_opponent_offer');
  await black.action({ type: 'offer_draw' }, f => f.type === 'state' && f.view.drawOffer === 'b');
  await replacement.action({ type: 'respond_draw', accept: true }, f => f.type === 'state' && f.view.phase === 'ended');
  check(replacement.view.result.reason === 'agreement' && replacement.view.crowns.b === 'bQ', 'draw agreement and reveal');
  await replacement.error({ type: 'move', from: 12, to: 20 }, 'wrong_phase');
  for (const client of [white, black, reopened, replacement]) privacy(client);
  const log = await observer.action({ type: 'get_log' }, f => f.type === 'log');
  check(log.moves.length === 1 && log.moves[0].at === log.events.find(e => e.type === 'move').t, 'move and export timestamps match');
  check(log.events.some(e => e.type === 'draw_declined') && log.events.some(e => e.type === 'left'), 'research events are logged');
  check(!JSON.stringify(log).includes('tokens'), 'export omits role tokens');

} finally {
  await Promise.all(clients.map(client => client.close()));
}
// Fresh clients keep failed selections and stale sockets out of the final-game checks.
try {
  const game = await playing('wK', 'bBf');
  await move(game.white, game.observer, 'e2', 'e4');
  await move(game.black, game.observer, 'g7', 'g5');
  await move(game.white, game.observer, 'd1', 'h5');
  await move(game.black, game.observer, 'a7', 'a6');
  await move(game.white, game.observer, 'h5', 'f7');
  check(game.white.view.phase === 'playing', 'decoy capture continues');
  await move(game.black, game.observer, 'a6', 'a5');
  await move(game.white, game.observer, 'f7', 'f8');
  check(game.white.view.result.reason === 'crown_captured' && game.white.view.result.winner === 'w', 'real crown capture ends immediately');
  await game.black.wait(f => f.type === 'state' && f.view.phase === 'ended');
  check(game.black.view.crowns.w === 'wK', 'both players see reveal'); privacy(game.white); privacy(game.black);
  const log = await game.observer.action({ type: 'get_log' }, f => f.type === 'log');
  check(log.moves.length === 7 && log.crowns.b === 'bBf', 'observer export matches full played game');
  const resignation = await playing();
  await resignation.black.action({ type: 'resign' }, f => f.type === 'state' && f.view.phase === 'ended');
  check(resignation.black.view.result.winner === 'w' && resignation.black.view.result.reason === 'resign', 'resignation');
  const bad = new Client(await create(), 'white', 'wrong-token');
  await bad.wait(f => f.type === 'error' && f.code === 'bad_token');
  const deadline = Date.now() + 3000; while (bad.closed === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 15));
  check(bad.closed === 4001, 'invalid token closes connection');
  console.log(`PASS: ${checks} assertions against real Worker: privacy, joins, selection, moves, reconnection, replacement, draws, crown capture, resignation, log export.`);
} finally { await Promise.all(clients.map(client => client.close())); }
