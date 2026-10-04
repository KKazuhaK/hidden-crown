import { readFileSync } from 'node:fs';
export function integer(name: string, fallback: number, minimum = 1) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
  return value;
}
export function configuration() {
  const port = integer('PORT', 8787), host = process.env.HOST ?? '127.0.0.1';
  const origin = new URL(process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`).origin;
  const secure = origin.startsWith('https:');
  if (!secure && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('PUBLIC_ORIGIN must use HTTPS outside localhost');
  const password = process.env.ADMIN_PASSWORD_FILE ? readFileSync(process.env.ADMIN_PASSWORD_FILE, 'utf8').trim() : process.env.ADMIN_PASSWORD;
  if (!password || password.length < 16 || password.length > 256) throw new Error('Set ADMIN_PASSWORD_FILE or ADMIN_PASSWORD with 16 to 256 characters');
  const username = process.env.ADMIN_USERNAME ?? 'admin';
  if (!username || username.length > 64) throw new Error('ADMIN_USERNAME requires 1 to 64 characters');
  const databaseUrl = process.env.DATABASE_URL_FILE ? readFileSync(process.env.DATABASE_URL_FILE, 'utf8').trim() : process.env.DATABASE_URL?.trim();
  if (databaseUrl && !['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)) throw new Error('DATABASE_URL must use PostgreSQL');
  const initialWait = integer('WAITING_TIMEOUT_MINUTES', 15);
  if (initialWait > 1440) throw new Error('WAITING_TIMEOUT_MINUTES must be 1 to 1440');
  const poolSize = integer('PG_POOL_MAX', 10, 2);
  if (poolSize > 100) throw new Error('PG_POOL_MAX must be 2 to 100');
  const proxies = new Set((process.env.TRUSTED_PROXIES ?? '').split(',').map(value => value.trim()).filter(Boolean));
  for (const peer of proxies) if (!/^[\da-fA-F:.]+$/.test(peer)) throw new Error('TRUSTED_PROXIES requires exact IP addresses');
  return { port, host, origin, secure, username, password, databaseUrl, poolSize, proxies, initialWait,
    databasePath: process.env.DATABASE_PATH ?? 'data/hidden-crown-v2.sqlite',
    maxRooms: integer('MAX_ROOMS', 10000), maxActiveRooms: integer('MAX_ACTIVE_ROOMS', 256),
    maxLoadedRooms: integer('MAX_LOADED_ROOMS', 256), maxConnections: integer('MAX_CONNECTIONS', 512),
    maxRoomBytes: integer('MAX_ROOM_BYTES', 4 * 1024 * 1024), maxCacheBytes: integer('MAX_CACHE_BYTES', 64 * 1024 * 1024),
    maxDatabaseBytes: integer('MAX_DATABASE_BYTES', 1024 * 1024 * 1024), maxStoredBytes: integer('MAX_STORED_BYTES', 768 * 1024 * 1024)
  };
}
export type Configuration = ReturnType<typeof configuration>;
