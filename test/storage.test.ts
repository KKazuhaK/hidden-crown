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

function initial(id: string): GameState {
  const ruleset = ruleRegistry.selection(), position = ruleRegistry.resolve(ruleset).initialize(ruleset);
  return { ...position, revision: 1, ruleset, initialPosition: structuredClone(position), roomId: id, createdAt: Date.now(), phase: 'playing', moves: [], drawOffer: null,
    joined: { w: true, b: true }, claimed: { w: true, b: true }, playStartedAt: 0, lastMoveAt: null, result: null,
    crowns: { w: 'wK', b: 'bK' }, tokens: { w: 'secret-white', b: 'secret-black', observer: 'secret-admin' } };
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
  it('allows exactly one concurrent writer at the same revision', async () => {
    const game = initial('CONCUR01'); await store.commit(game, [created], 0);
    const next = { ...game, revision: 2 };
    const result = await Promise.allSettled([store.commit(next, [{ ...created, type: 'joined' }], 1), store.commit(next, [{ ...created, type: 'left' }], 1)]);
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect((await store.load(game.roomId))!.events).toHaveLength(2);
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
    await expect(store.commit({ ...game, revision: 2, ruleset: { ...game.ruleset, version: 2 } }, [], 1)).rejects.toThrow('room_ruleset_immutable');
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
