import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SqlValue } from './contract';

mkdirSync(dirname(workerData.path), { recursive: true });
const db = new DatabaseSync(workerData.path);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=5000; PRAGMA journal_size_limit=8388608;`);
const pageSize = Number(db.prepare('PRAGMA page_size').get()!.page_size);
db.exec(`PRAGMA max_page_count=${Math.floor(workerData.maxBytes / pageSize)}`);
parentPort!.on('message', ({ id, sql, values, close }: { id: number; sql?: string; values?: SqlValue[]; close?: boolean }) => {
  try {
    if (close) { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); parentPort!.postMessage({ id, rows: [] }); return; }
    const bound: SqlValue[] = [];
    const query = sql!.replace(/\$(\d+)/g, (_, index) => { bound.push(values![Number(index) - 1]); return '?'; });
    const rows = db.prepare(query).all(...bound);
    parentPort!.postMessage({ id, rows });
  } catch { parentPort!.postMessage({ id, error: 'database_query_failed' }); }
});
