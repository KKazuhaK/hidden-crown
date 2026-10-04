export type SqlValue = string | number | null;
export type SqlRow = Record<string, unknown>;
export interface Queryable { query<T extends SqlRow = SqlRow>(sql: string, values?: SqlValue[]): Promise<T[]> }
export interface Database extends Queryable {
  readonly kind: 'sqlite' | 'postgres';
  transaction<T>(callback: (transaction: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
