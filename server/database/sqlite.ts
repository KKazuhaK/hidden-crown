import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { Database, Queryable, SqlRow, SqlValue } from './contract';

export class SqliteDatabase implements Database {
  readonly kind = 'sqlite';
  private worker: Worker;
  private nextId = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private failed = false;
  private pending = new Map<number, { resolve: (rows: SqlRow[]) => void; reject: (error: Error) => void }>();
  constructor(path: string, maxBytes: number, workerUrl = new URL('./sqlite-worker.mjs', import.meta.url).href) {
    this.worker = new Worker(fileURLToPath(workerUrl), { workerData: { path, maxBytes }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } });
    this.worker.on('message', message => {
      const task = this.pending.get(message.id); if (!task) return;
      this.pending.delete(message.id);
      if (message.error) task.reject(new Error(message.error)); else task.resolve(message.rows);
    });
    const failed = () => { this.failed = true; for (const task of this.pending.values()) task.reject(new Error('database_unavailable')); this.pending.clear(); };
    this.worker.on('error', failed); this.worker.on('exit', failed);
  }
  private raw<T extends SqlRow>(sql: string, values: SqlValue[] = []): Promise<T[]> {
    if (this.failed || this.stopped) return Promise.reject(new Error('database_unavailable'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve: rows => resolve(rows as T[]), reject }); this.worker.postMessage({ id, sql, values }); });
  }
  private exclusive<T>(callback: () => Promise<T>) { const result = this.tail.then(callback); this.tail = result.catch(() => {}); return result; }
  query<T extends SqlRow = SqlRow>(sql: string, values: SqlValue[] = []) { return this.exclusive(() => this.raw<T>(sql, values)); }
  transaction<T>(callback: (transaction: Queryable) => Promise<T>) {
    return this.exclusive(async () => {
      await this.raw('BEGIN IMMEDIATE');
      try { const value = await callback({ query: <R extends SqlRow>(sql: string, values?: SqlValue[]) => this.raw<R>(sql, values) }); await this.raw('COMMIT'); return value; }
      catch (error) { await this.raw('ROLLBACK').catch(() => {}); throw error; }
    });
  }
  async close() {
    await this.exclusive(async () => {
      if (this.stopped) return;
      if (!this.failed) {
        const id = ++this.nextId;
        await new Promise<void>((resolve, reject) => { this.pending.set(id, { resolve: () => resolve(), reject }); this.worker.postMessage({ id, close: true }); });
      }
      this.stopped = true; await this.worker.terminate();
    });
  }
}
