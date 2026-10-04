import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { adminHeaders } from './admin-test-auth.mjs';
const base = process.env.HIDDEN_CROWN_URL ?? 'http://127.0.0.1:8787';
const admin = await adminHeaders(base);
const sockets = [];
let checks = 0;
function equal(actual, expected) { assert.deepEqual(actual, expected); checks++; }
async function create() {
  const response = await fetch(`${base}/api/rooms`, { method: 'POST' });
  equal(response.status, 201);
  return response.json();
}
async function claim(code, options = {}) {
  const response = await fetch(`${base}/api/rooms/${code}/join`, { method: 'POST', ...options });
  equal(response.headers.get('cache-control'), 'no-store');
  return { status: response.status, data: await response.json() };
}
async function connect(room, role) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/${room.roomId}${role === 'observer' ? '?admin=1' : ''}`, role === 'observer' ? { headers: admin } : {}), frames = [];
  sockets.push(ws);
  ws.addEventListener('message', event => frames.push(JSON.parse(event.data)));
  ws.addEventListener('open', () => { if (role !== 'observer') ws.send(JSON.stringify({ type: 'hello', token: new URL(room.links[role], base).hash.slice(3) })); });
  async function wait(predicate, start = 0) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const frame = frames.slice(start).find(predicate); if (frame) return frame;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error(`Timed out: ${role}`);
  }
  async function action(message, predicate) { const start = frames.length; ws.send(JSON.stringify(message)); return wait(predicate, start); }
  equal((await wait(frame => frame.type === 'welcome')).role, { white: 'w', black: 'b', observer: 'observer' }[role]);
  await wait(frame => frame.type === 'state');
  return { ws, wait, action, get view() { return frames.findLast(frame => frame.type === 'state').view; } };
}
try {
  equal((await claim('INVALID')).data.code, 'invalid_room_number');
  const unknown = await claim('ZZZZZZZZ'); equal(unknown.status, 404); equal(unknown.data.code, 'room_not_found');
  const room = await create();
  for (const body of ['{"role":"observer"}', '{"token":"secret"}', '[]', 'null', 'broken']) {
    const rejected = await claim(room.roomId, { body }); equal(rejected.status, 400); equal(rejected.data.code, 'bad_request');
  }
  equal((await claim(room.roomId, { method: 'GET' })).status, 405);
  equal((await claim(room.roomId)).data.code, 'choose_side');
  const whiteSeat = await claim(room.roomId.toLowerCase(), { body: JSON.stringify({ color: 'w' }) });
  equal(whiteSeat.status, 200); equal(whiteSeat.data, { roomId: room.roomId, role: 'w', link: room.links.white });
  const observer = await connect(room, 'observer'); equal(observer.view.phase, 'lobby');
  equal(Object.hasOwn(observer.view, 'claimed'), false);
  const blackSeat = await claim(room.roomId); equal(blackSeat.data, { roomId: room.roomId, role: 'b', link: room.links.black });
  equal(observer.view.phase, 'lobby'); // Reserving alone does not count as joining.
  const full = await claim(room.roomId); equal(full.status, 409); equal(full.data, { code: 'room_full' });
  const white = await connect(room, 'white'); equal(white.view.phase, 'lobby');
  equal(Object.hasOwn(white.view, 'claimed'), false); equal(Object.hasOwn(white.view, 'tokens'), false);
  const black = await connect(room, 'black'); await white.wait(frame => frame.type === 'state' && frame.view.phase === 'crown_select');
  white.ws.close(); await observer.wait(frame => frame.type === 'state' && !frame.view.connected.w && frame.view.connected.b);
  equal((await claim(room.roomId)).data.code, 'room_full');
  const recovered = await connect(room, 'white'); equal(recovered.view.phase, 'crown_select');
  await recovered.action({ type: 'select_crown', pieceId: 'wQ' }, frame => frame.type === 'state' && frame.view.crownLocked.w);
  await black.action({ type: 'select_crown', pieceId: 'bQ' }, frame => frame.type === 'state' && frame.view.phase === 'playing');
  await recovered.wait(frame => frame.type === 'state' && frame.view.phase === 'playing');
  equal((await claim(room.roomId)).data.code, 'room_started');
  await recovered.action({ type: 'resign' }, frame => frame.type === 'state' && frame.view.phase === 'ended');
  equal((await claim(room.roomId)).data.code, 'room_ended');
  const log = await observer.action({ type: 'get_log' }, frame => frame.type === 'log');
  equal(log.events.filter(event => event.type === 'seat_claimed').map(event => event.actor), ['w', 'b']);
  equal(JSON.stringify(log).includes(new URL(room.links.white, base).hash.slice(3)), false);
  const direct = await create(); await connect(direct, 'white');
  equal((await claim(direct.roomId)).data.role, 'b'); // Private links and codes share reservations.
  const concurrent = await create();
  const results = await Promise.all([claim(concurrent.roomId, { body: JSON.stringify({ color: 'b' }) }), claim(concurrent.roomId, { body: JSON.stringify({ color: 'b' }) }), claim(concurrent.roomId, { body: JSON.stringify({ color: 'b' }) })]);
  equal(results.map(result => result.status).sort(), [200, 200, 409]);
  equal(results.filter(result => result.status === 200).map(result => result.data.role).sort(), ['b', 'w']);
  console.log(`PASS: ${checks} room-number assertions, including concurrent claims, role privacy, offline recovery and lifecycle restrictions.`);
} finally { for (const ws of sockets) ws.close(); }
