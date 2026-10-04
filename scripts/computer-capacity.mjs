// Disposable CI/local servers only. Creates 50 hard-mode rooms, then deletes those IDs.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { adminHeaders } from './admin-test-auth.mjs';
const base = process.env.HIDDEN_CROWN_URL ?? 'http://127.0.0.1:8798';
const admin = await adminHeaders(base), rooms = [], sockets = [];
admin['X-Forwarded-For'] = '198.51.100.200';
const session = await fetch(base + '/api/admin/session', { headers: admin });
const mutate = { ...admin, 'X-CSRF-Token': (await session.json()).csrf };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const times = [], started = performance.now(); let monitoring = true;
async function api(path, method = 'GET', body, headers = admin) {
  const response = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `Computer capacity HTTP ${response.status}`); return response.json();
}
const monitor = (async () => { while (monitoring) { const start = performance.now(); await api('/healthz'); times.push(performance.now() - start); await pause(500); } })();
try {
  // Trusted test proxy sends distinct synthetic addresses; production peers cannot spoof these.
  const net = await api('/api/admin/network', 'GET', undefined, { ...admin, 'X-Forwarded-For': '198.51.100.200' });
  assert.equal(net.clientIp, '198.51.100.200', 'Use a disposable server with its exact test proxy trusted');
  const jobs = Array.from({ length: 50 }, async (_, i) => {
    const headers = { 'X-Forwarded-For': `198.51.100.${i + 1}` };
    const room = await api('/api/rooms', 'POST', { computer: { humanColor: 'b', difficulty: 'hard' } }, headers); rooms.push(room);
    const frames = [], ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws/' + room.roomId, { headers }); sockets.push(ws);
    ws.on('error', () => {}); ws.on('message', raw => frames.push(JSON.parse(raw)));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: new URL(room.link, base).hash.slice(3) })));
    async function wait(predicate) {
      for (let j = 0; j < 2000; j++) { const found = frames.find(predicate); if (found) return found; await pause(20); }
      throw new Error('Computer capacity game timed out');
    }
    await wait(f => f.type === 'state' && f.view.phase === 'crown_select');
    ws.send(JSON.stringify({ type: 'select_crown', pieceId: 'bK' }));
    const first = await wait(f => f.type === 'state' && f.view.moves.length === 1 && f.view.turn === 'b');
    const m = first.view.legalMoves[0]; ws.send(JSON.stringify({ type: 'move', from: m.from, to: m.to }));
    const last = await wait(f => f.type === 'state' && f.view.moves.length === 3 && f.view.turn === 'b');
    assert.equal(last.view.phase, 'playing'); assert.ok(frames.every(f => f.type !== 'error')); assert.equal(Object.hasOwn(last.view, 'crowns'), false);
  });
  await Promise.all(jobs);
  const metrics = await api('/api/admin/metrics');
  monitoring = false; await monitor;
  const sorted = times.sort((a,b) => a-b), p95 = sorted[Math.floor(sorted.length * .95)];
  assert.ok(p95 < 2000, 'Health check should remain responsive while workers search');
  console.log(JSON.stringify({ computerGames: 50, difficulty: 'hard', computerMoves: 100, totalMoves: 150, durationMs: Math.round(performance.now() - started), healthP95Ms: Math.round(p95 * 100) / 100,
    rssMiB: Math.round(metrics.memoryRssBytes / 1048576), eventLoopP95Ms: metrics.eventLoopP95Ms, workers: metrics.limits.computerWorkers }));
} finally {
  monitoring = false; await monitor;
  for (const socket of sockets) socket.close();
  for (const room of rooms) await api(`/api/admin/rooms/${room.roomId}`, 'DELETE', undefined, mutate);
}
