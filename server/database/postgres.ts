import pg from 'pg';
import type { Database, Queryable, SqlRow, SqlValue } from './contract';

export class PostgresDatabase implements Database {
  readonly kind = 'postgres';
  private pool: pg.Pool;
  private owner?: pg.PoolClient;
  constructor(connectionString: string, maximum: number) {
    this.pool = new pg.Pool({ connectionString, max: maximum, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 5000, query_timeout: 6000, application_name: 'hidden-crown' });
    this.pool.on('error', () => console.error('Database connection unavailable'));
  }
  async acquireOwnership() {
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT pg_try_advisory_lock(121237, 2) AS owned');
      if (!result.rows[0].owned) throw new Error('database_already_owned');
      this.owner = client;
      client.on('error', () => { console.error('Database ownership lost'); process.kill(process.pid, 'SIGTERM'); });
    } catch (error) { client.release(); throw error; }
  }
  async query<T extends SqlRow = SqlRow>(sql: string, values: SqlValue[] = []): Promise<T[]> { return (await this.pool.query(sql, values)).rows; }
  async transaction<T>(callback: (transaction: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback({ query: async <R extends SqlRow>(sql: string, values?: SqlValue[]) => (await client.query(sql, values)).rows as R[] });
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async close() {
    if (this.owner) { await this.owner.query('SELECT pg_advisory_unlock(121237, 2)').catch(() => {}); this.owner.release(); this.owner = undefined; }
    await this.pool.end();
  }
}
