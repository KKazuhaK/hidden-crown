import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { adminHeaders } from './admin-test-auth.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const base = process.env.HIDDEN_CROWN_URL ?? 'http://127.0.0.1:8787';
const admin = await adminHeaders(base);
const file = new URL('../test-artifacts/persistence.json', import.meta.url);
const sockets = [];
async function create() { return (await fetch(`${base}/api/rooms`, { method: 'POST' })).json(); }
async function connect(room, role) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/${room.roomId}${role === 'observer' ? '?admin=1' : ''}`, role === 'observer' ? { headers: admin } : {}), frames = [];
  sockets.push(ws);
  ws.addEventListener('message', event => frames.push(JSON.parse(event.data)));
  ws.addEventListener('open', () => { if (role !== 'observer') ws.send(JSON.stringify({ type: 'hello', token: new URL(room.links[role], base).hash.slice(3) })); });
  async function wait(predicate, start = 0) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = frames.slice(start).find(predicate); if (result) return result;
      await new Promise(r => setTimeout(r, 15));
    }
    throw new Error('Persistence test timed out');
  }
  async function action(message, predicate) {
    const start = frames.length; ws.send(JSON.stringify(message)); return wait(predicate, start);
  }
  await wait(frame => frame.type === 'welcome');
  const view = (await wait(frame => frame.type === 'state')).view;
  return { ws, view, wait, action };
}
try {
  if (process.argv[2] === 'prepare') {
    const lobby = await create(); await connect(lobby, 'white');
    const reserved = await create();
    assert.equal((await fetch(`${base}/api/rooms/${reserved.roomId}/join`, { method: 'POST', body: JSON.stringify({ color: 'w' }) })).status, 200);
    const playing = await create(); const white = await connect(playing, 'white'), black = await connect(playing, 'black');
    await white.wait(frame => frame.type === 'state' && frame.view.phase === 'crown_select');
    await white.action({ type: 'select_crown', pieceId: 'wK' }, frame => frame.type === 'state' && frame.view.crownLocked.w);
    await black.action({ type: 'select_crown', pieceId: 'bK' }, frame => frame.type === 'state' && frame.view.phase === 'playing');
    await white.wait(frame => frame.type === 'state' && frame.view.phase === 'playing');
    const state = await white.action({ type: 'move', from: 12, to: 28 }, frame => frame.type === 'state' && frame.view.moves.length === 1);
    await mkdir(new URL('../test-artifacts/', import.meta.url), { recursive: true });
    await writeFile(file, JSON.stringify({ lobby, reserved, playing, record: state.view.moves[0] }));
    console.log('Prepared persisted lobby and one-move game. Restart the server, then run verify.');
  } else if (process.argv[2] === 'verify') {
    const fixture = JSON.parse(await readFile(file, 'utf8'));
    const black = await connect(fixture.lobby, 'black');
    assert.equal(black.view.phase, 'crown_select'); // White previously joined but is offline.
    assert.equal(black.view.connected.w, false);
    const claim = await fetch(`${base}/api/rooms/${fixture.reserved.roomId}/join`, { method: 'POST' });
    assert.equal((await claim.json()).role, 'b'); // White reservation survived without ever connecting.
    const full = await fetch(`${base}/api/rooms/${fixture.reserved.roomId}/join`, { method: 'POST' });
    assert.equal((await full.json()).code, 'room_full');
    const reservedObserver = await connect(fixture.reserved, 'observer');
    assert.equal(reservedObserver.view.phase, 'lobby');
    const reservedWhite = await connect(fixture.reserved, 'white');
    assert.equal(reservedWhite.view.phase, 'lobby');
    const reservedBlack = await connect(fixture.reserved, 'black');
    assert.equal(reservedBlack.view.phase, 'crown_select');
    const observer = await connect(fixture.playing, 'observer');
    assert.equal(observer.view.phase, 'playing');
    assert.equal(observer.view.board[28], 'wPe');
    assert.equal(observer.view.turn, 'b');
    assert.deepEqual(observer.view.crowns, { w: 'wK', b: 'bK' });
    assert.deepEqual(observer.view.moves, [fixture.record]);
    assert.deepEqual(observer.view.connected, { w: false, b: false });
    const log = await observer.action({ type: 'get_log' }, frame => frame.type === 'log');
    assert.deepEqual(log.moves, [fixture.record]);
    assert.equal(log.events.filter(event => event.type === 'crown_locked').length, 2);
    assert.equal(log.events.filter(event => event.type === 'move').length, 1);
    console.log('PASS: Worker restart restores joined flags, seat reservations, phase, board, turn, crowns, move timestamps and event log; presence reflects only live sockets.');
  } else throw new Error('Usage: node scripts/persistence-smoke.mjs prepare|verify');
} finally { for (const ws of sockets) ws.close(); }
