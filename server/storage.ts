import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GameState, LogEvent } from '../src/types';

export class Store {
  db: DatabaseSync;
  constructor(path: string, maxBytes: number) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      PRAGMA journal_size_limit=8388608;
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, state TEXT NOT NULL, log TEXT NOT NULL,
        created_at INTEGER NOT NULL, phase TEXT NOT NULL, ply INTEGER NOT NULL, bytes INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS room_created ON rooms(created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, room TEXT);
      PRAGMA max_page_count=${Math.floor(maxBytes / 4096)};`);
  }
  row(id: string) { return this.db.prepare('SELECT state,log FROM rooms WHERE id=?').get(id); }
  count() { return Number(this.db.prepare('SELECT COUNT(*) AS n FROM rooms').get()!.n); }
  bytes() { return Number(this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM rooms').get()!.n); }
  write(state: GameState, events: LogEvent[], maxRoomBytes: number) {
    const json = JSON.stringify(state), log = JSON.stringify(events), bytes = Buffer.byteLength(json) + Buffer.byteLength(log);
    if (bytes > maxRoomBytes) throw new Error('room_storage_limit');
    this.db.prepare(`INSERT INTO rooms VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      state=excluded.state,log=excluded.log,phase=excluded.phase,ply=excluded.ply,bytes=excluded.bytes`)
      .run(state.roomId, json, log, state.createdAt, state.phase, state.ply, bytes);
  }
  audit(action: string, room: string | null = null) {
    this.db.prepare('INSERT INTO audit(at,action,room) VALUES(?,?,?)').run(Date.now(), action, room);
    this.db.prepare('DELETE FROM audit WHERE id <= (SELECT COALESCE(MAX(id),0)-10000 FROM audit)').run();
  }
  delete(id: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('DELETE FROM rooms WHERE id=?').run(id); this.audit('room_deleted', id); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
