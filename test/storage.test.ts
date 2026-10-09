import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import pg from 'pg';
import { Store } from '../server/storage';
import { SqliteDatabase } from '../server/database/sqlite';
import { PostgresDatabase } from '../server/database/postgres';
import type { Database } from '../server/database/contract';
import { ruleRegistry } from '../src/rules/registry';
import type { GameState, LogEvent } from '../src/types';
import { standardChess, drawClaim } from '../src/rules/standard-chess';

function initial(id: string, version = 4): GameState {
  const ruleset = ruleRegistry.selection({ id: 'hidden-crown', version }), position = ruleRegistry.resolve(ruleset).initialize(ruleset);
  return { ...position, revision: 1, ruleset, initialPosition: structuredClone(position), roomId: id, createdAt: Date.now(), phase: 'playing', moves: [], drawOffer: null,
    joined: { w: true, b: true }, claimed: { w: true, b: true }, playStartedAt: 0, lastMoveAt: null, result: null,
    crowns: { w: 'wQ', b: 'bQ' }, tokens: { w: 'secret-white', b: 'secret-black', observer: 'secret-admin' } };
}
const created: LogEvent = { t: 0, actor: 'system', type: 'room_created' };
const kinds = process.env.TEST_DATABASE_URL ? ['sqlite', 'postgres'] : ['sqlite'];
for (const kind of kinds) describe(`${kind} repository contract`, () => {
  let database: Database, store: Store, databaseName: string;
  beforeAll(async () => {
    if (kind === 'sqlite') {
      const folder = `test-artifacts/storage-${randomUUID()}`; await mkdir(folder, { recursive: true });
      database = new SqliteDatabase(`${folder}/test.sqlite`, 64 * 1024 * 1024, new URL('../dist/sqlite-worker.mjs', import.meta.url).href);
    } else {
      databaseName = 'hc_storage_' + randomUUID().replaceAll('-', '');
      const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await admin.connect();
      try { await admin.query(`CREATE DATABASE ${databaseName}`); } finally { await admin.end(); }
      const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = '/' + databaseName;
      database = new PostgresDatabase(url.href, 4);
    }
    store = new Store(database, 1024 * 1024); await store.initialize();
  });
  afterAll(async () => {
    await store?.close();
    if (databaseName) { const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await admin.connect(); try { await admin.query(`DROP DATABASE ${databaseName}`); } finally { await admin.end(); } }
  });
  it('appends history, stores only a position snapshot and survives reloading', async () => {
    const game = initial('HISTORY1'); await store.commit(game, [created], 0);
    const move = ruleRegistry.resolve(game.ruleset).legalMoves(game, 'w').find(move => move.from === 12 && move.to === 28)!;
    const applied = ruleRegistry.resolve(game.ruleset).applyMove(game, move, 1000); applied.state.revision++;
    await store.commit(applied.state, [{ t: 1000, actor: 'w', type: 'move', data: { ...applied.record } }], 1);
    const snapshot = await store.load(game.roomId); expect(snapshot!.state.moves).toEqual([applied.record]); expect(snapshot!.events).toHaveLength(2);
    const rows = await database.query('SELECT state FROM hc_rooms WHERE id=$1', [game.roomId]);
    expect(JSON.parse(String(rows[0].state))).not.toHaveProperty('moves');
    expect((await database.query('SELECT * FROM hc_moves WHERE room_id=$1', [game.roomId]))).toHaveLength(1);
    await expect(store.commit(applied.state, [], 1)).rejects.toThrow('room_conflict');
  });
  it('persists private bonus interrogations without adding move plies, then reloads and exports them', async () => {
    let game = initial('PRIVATE5', 5);
    game.board[59] = null; game.pieces.bQ.square = 52; game.board[52] = 'bQ'; game.pieces.bPe.square = null;
    await store.commit(game, [created], 0);
    const rules = ruleRegistry.resolve(game.ruleset), result = rules.applyCommand(game, 'w', { type: 'interrogate', targetId: 'bQ' }, 5000);
    if ('error' in result) throw new Error(result.error);
    game = { ...result.state, revision: 2 }; await store.commit(game, result.events, 1);
    const saved = (await store.load(game.roomId))!;
    expect(saved.state.moves).toEqual([]); expect(saved.state.ply).toBe(0); expect(saved.state.turn).toBe('w');
    expect(rules.interrogationRecords!(saved.state)[0]).toMatchObject({ kind: 'interrogation', answer: 'crown', targetId: 'bQ' });
    expect(saved.events.at(-1)?.type).toBe('interrogation');
    const moved = rules.applyCommand(saved.state, 'w', { type: 'move', from: 12, to: 28 }, 6000);
    if ('error' in moved) throw new Error(moved.error);
    await store.commit({ ...moved.state, revision: 3 }, moved.events, 2);
    const reloaded = (await store.load(game.roomId))!;
    expect(reloaded.state.moves).toHaveLength(1); expect(reloaded.state.moves[0].kind).toBeUndefined();
    expect(rules.interrogationRecords!(reloaded.state)).toHaveLength(1); expect(reloaded.state.turn).toBe('b');
  });
  it('preserves standard rules, repetition rights and SAN history across storage reload', async () => {
    const ruleset = ruleRegistry.selectionForCreation({ id: 'standard-chess', version: 1 });
    let game: GameState = { ...initial('STANDARD'), ...standardChess.initialize(ruleset), ruleset, crowns: { w: null, b: null } };
    await store.commit(game, [created], 0);
    for (const [from, to] of [[6,21],[62,45],[21,6],[45,62],[6,21],[62,45],[21,6]]) {
      const result = standardChess.applyCommand(game, game.turn, { type: 'move', from, to }, game.revision * 1000);
      if ('error' in result) throw new Error(result.error);
      const expected = game.revision; game = { ...result.state, revision: expected + 1 };
      await store.commit(game, result.events, expected);
    }
    const loaded = (await store.load('STANDARD'))!.state;
    expect(loaded.ruleset).toEqual(ruleset); expect(loaded.crowns).toEqual({ w: null, b: null });
    expect(loaded.moves.map(move => move.notation)).toEqual(['Nf3','Nf6','Ng1','Ng8','Nf3','Nf6','Ng1']);
    expect(drawClaim(loaded)).toEqual(drawClaim(game)); expect(drawClaim(loaded)?.reason).toBe('threefold_repetition');
  });
  it('preserves historical v3 interrogation answers and later undo', async () => {
    let game = initial('INTRDB01', 3);
    const king = game.pieces.wK; game.board[king.square!] = null; king.square = 19; game.board[19] = king.id;
    const target = game.pieces.bRa; game.board[target.square!] = null;
    game.pieces[game.board[51]!].square = null; target.square = 51; game.board[51] = target.id;
    game.initialPosition = structuredClone({ pieces: game.pieces, board: game.board, turn: game.turn });
    const rules = ruleRegistry.resolve(game.ruleset); await store.commit(game, [created], 0);
    async function act(color: 'w' | 'b', command: Parameters<typeof rules.applyCommand>[2]) {
      const result = rules.applyCommand(game, color, command, 1000 + game.ply * 1000); if ('error' in result) throw new Error(result.error);
      result.state.revision++; await store.commit(result.state, result.events, game.revision);
      game = (await store.load(game.roomId))!.state; return result;
    }
    await act('w', { type: 'interrogate', targetId: 'bRa' });
    expect(game.moves[0].answer).toBe('clear'); expect(game.moves[0].kind).toBe('interrogation');
    expect(rules.interrogationTargets!(game, 'w')).not.toContain('bRa');
    expect((await store.load(game.roomId))!.events.at(-1)?.data?.answer).toBe('clear');
    await act('b', { type: 'move', from: 52, to: 36 });
    await act('w', { type: 'move', from: 12, to: 28 });
    await act('w', { type: 'request_undo' }); await act('b', { type: 'respond_undo', accept: true });
    expect(game.moves).toHaveLength(2); expect(game.moves[0].answer).toBe('clear'); expect(game.board[12]).toBe('wPe');
    const events = (await store.load(game.roomId))!.events; expect(events.some(e => e.type === 'interrogation')).toBe(true);
  });
  it('allows exactly one concurrent writer at the same revision', async () => {
    const game = initial('CONCUR01'); await store.commit(game, [created], 0);
    const next = { ...game, revision: 2 };
    const result = await Promise.allSettled([store.commit(next, [{ ...created, type: 'joined' }], 1), store.commit(next, [{ ...created, type: 'left' }], 1)]);
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect((await store.load(game.roomId))!.events).toHaveLength(2);
  });
  it('loads completed historical rooms and their undo audit without rewriting records', async () => {
    const game = initial('OLDDONE1', 3); game.phase = 'ended'; game.result = { winner: 'w', reason: 'resign' };
    const events: LogEvent[] = [created, { t: 1000, actor: 'w', type: 'undo_requested', data: { targetPly: 0 } }, { t: 2000, actor: 'b', type: 'undo_accepted', data: { targetPly: 0, removed: [] } }];
    await store.commit(game, events, 0);
    const loaded = (await store.load(game.roomId))!;
    expect(loaded.state).toEqual(game); expect(loaded.events).toEqual(events);
    expect(ruleRegistry.resolve(loaded.state.ruleset).version).toBe(3);
  });
  it('atomically rewinds only approved moves, preserves audit and reuses the next ply', async () => {
    const rules = ruleRegistry.resolve(initial('UNDO0001', 3).ruleset);
    let game = initial('UNDO0001', 3); await store.commit(game, [created], 0);
    async function act(color: 'w' | 'b', value: Parameters<typeof rules.applyCommand>[2], now: number) {
      const next = rules.applyCommand(game, color, value, now);
      if ('error' in next) throw new Error(next.error);
      next.state.revision = game.revision + 1;
      await store.commit(next.state, next.events, game.revision); game = next.state;
    }
    await act('w', { type: 'move', from: 12, to: 28 }, 1000);
    await act('b', { type: 'move', from: 52, to: 36 }, 2000);
    const removed = structuredClone(game.moves);
    await expect(store.commit({ ...game, revision: game.revision + 1, ply: 0, moves: [] }, [], game.revision)).rejects.toThrow('room_history_inconsistent');
    await act('w', { type: 'request_undo' }, 3000);
    const accepted = rules.applyCommand(game, 'b', { type: 'respond_undo', accept: true }, 4000);
    if ('error' in accepted) throw new Error(accepted.error);
    accepted.state.revision = game.revision + 1;
    await expect(store.commit(accepted.state, [{ ...accepted.events[0], data: { targetPly: 0, removed: [] } }], game.revision)).rejects.toThrow('room_history_inconsistent');
    await act('b', { type: 'respond_undo', accept: true }, 4000);
    const loaded = (await store.load(game.roomId))!;
    expect(loaded.state.ply).toBe(0); expect(loaded.state.moves).toEqual([]);
    expect(loaded.events.filter(event => event.type === 'move')).toHaveLength(2);
    expect(loaded.events.at(-1)?.data?.removed).toEqual(removed);
    expect(loaded.state.board).toEqual(initial(game.roomId).board);
    const rows = await database.query('SELECT bytes,history_bytes,state FROM hc_rooms WHERE id=$1', [game.roomId]);
    expect(Number(rows[0].history_bytes)).toBe(loaded.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0));
    expect(Number(rows[0].bytes)).toBe(Number(rows[0].history_bytes) + Buffer.byteLength(String(rows[0].state)));
    game = loaded.state;
    await act('w', { type: 'move', from: 11, to: 27 }, 5000);
    expect((await store.load(game.roomId))!.state.moves[0]).toMatchObject({ ply: 1, from: 11, to: 27, thinkMs: 1000 });
  });
  it('rolls back deleted moves too when the undo audit insert fails', async () => {
    let game = initial('UNDOFAIL', 3); const rules = ruleRegistry.resolve(game.ruleset);
    await store.commit(game, [created], 0);
    const moved = rules.applyCommand(game, 'w', { type: 'move', from: 12, to: 28 }, 1000);
    if ('error' in moved) throw new Error(moved.error);
    game = { ...moved.state, revision: 2 }; await store.commit(game, moved.events, 1);
    const pending = rules.applyCommand(game, 'w', { type: 'request_undo' }, 2000);
    if ('error' in pending) throw new Error(pending.error);
    game = { ...pending.state, revision: 3 }; await store.commit(game, pending.events, 2);
    const accepted = rules.applyCommand(game, 'b', { type: 'respond_undo', accept: true }, 3000);
    if ('error' in accepted) throw new Error(accepted.error);
    await database.query('INSERT INTO hc_events VALUES($1,$2,$3,$4)', [game.roomId, 4, 0, JSON.stringify(created)]);
    await expect(store.commit({ ...accepted.state, revision: 4 }, accepted.events, 3)).rejects.toThrow();
    const loaded = (await store.load(game.roomId))!.state;
    expect(loaded.moves).toEqual(game.moves); expect(loaded.undoRequest).toEqual(game.undoRequest); expect(loaded.revision).toBe(3);
  });
  it('rolls back snapshot changes if appending an event fails', async () => {
    const game = initial('ROLLBACK'); await store.commit(game, [created], 0);
    // Duplicate sequence deliberately exercises a database failure after UPDATE.
    await database.query('INSERT INTO hc_events VALUES($1,$2,$3,$4)', [game.roomId, 2, 0, JSON.stringify(created)]);
    await expect(store.commit({ ...game, revision: 2 }, [created], 1)).rejects.toThrow();
    expect((await store.load(game.roomId))!.state.revision).toBe(1);
  });
  it('cascades permanent deletion and rejects a stale commit after deletion', async () => {
    await store.delete('HISTORY1'); expect(await store.load('HISTORY1')).toBeUndefined();
    expect(await database.query('SELECT * FROM hc_moves WHERE room_id=$1', ['HISTORY1'])).toHaveLength(0);
    expect(await database.query('SELECT * FROM hc_events WHERE room_id=$1', ['HISTORY1'])).toHaveLength(0);
    await expect(store.commit({ ...initial('HISTORY1'), revision: 3 }, [], 2)).rejects.toThrow('room_conflict');
  });
  it('bounds room size and refuses changing the rule version of a stored game', async () => {
    const game = initial('BOUNDARY'); await store.commit(game, [], 0);
    await expect(store.commit({ ...game, revision: 2, ruleState: { big: 'x'.repeat(1024 * 1024) } }, [], 1)).rejects.toThrow('room_storage_limit');
    await expect(store.commit({ ...game, revision: 2, ruleset: { ...game.ruleset, version: 1 } }, [], 1)).rejects.toThrow('room_ruleset_immutable');
    expect((await store.load(game.roomId))!.state.revision).toBe(1);
  });
  it('applies schema migrations once and persists settings and sessions', async () => {
    await store.initialize(); expect(await database.query('SELECT * FROM hc_schema_migrations')).toHaveLength(2);
    await store.setMetadata('waiting_minutes', '15'); expect(await store.metadata('waiting_minutes')).toBe('15');
    await store.addSession('hash', 'csrf', Date.now() + 10000); expect((await store.session('hash'))?.csrf).toBe('csrf');
    await store.deleteSession('hash'); expect(await store.session('hash')).toBeNull();
  });
  it('does not vary storage admission bytes with the chosen crown ID length', async () => {
    const short = initial('CROWN001'), long = initial('CROWN002');
    long.crowns.w = 'wRh';
    const event = (pieceId: string): LogEvent => ({ t: 0, actor: 'w', type: 'crown_locked', data: { pieceId } });
    expect(await store.commit(short, [event('wK')], 0)).toBe(await store.commit(long, [event('wRh')], 0));
    expect((await store.load(long.roomId))!.state.crowns.w).toBe('wRh');
    expect((await store.load(short.roomId))!.events[0].data?.pieceId).toBe('wK');
  });
  it('persists immutable computer seats and counts only unfinished computer games', async () => {
    const g = initial('COMPUTER'); g.computer = { color: 'b', difficulty: 'hard' };
    await store.commit(g, [], 0); expect(await store.computerCount()).toBe(1);
    expect((await store.load(g.roomId))!.state.computer).toEqual(g.computer);
    expect((await store.header(g.roomId))!.computer_color).toBe('b');
    await expect(store.commit({ ...g, revision: 2, computer: { color: 'w', difficulty: 'hard' } }, [], 1)).rejects.toThrow('room_computer_immutable');
    await store.commit({ ...g, revision: 2, phase: 'ended', result: { winner: null, reason: 'admin' } }, [], 1);
    expect(await store.computerCount()).toBe(0); await store.delete(g.roomId);
  });
});
