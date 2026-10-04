import type { Database } from './contract';
const versions = [{ version: 1, statements: [
  `CREATE TABLE hc_rooms(id TEXT PRIMARY KEY,state TEXT NOT NULL,revision INTEGER NOT NULL,
    created_at BIGINT NOT NULL,phase TEXT NOT NULL,ply INTEGER NOT NULL,bytes BIGINT NOT NULL,
    history_bytes BIGINT NOT NULL,event_count INTEGER NOT NULL,ruleset_id TEXT NOT NULL,ruleset_version INTEGER NOT NULL)`,
  'CREATE INDEX hc_room_created ON hc_rooms(created_at DESC,id DESC)',
  'CREATE INDEX hc_room_expiry ON hc_rooms(phase,created_at)',
  `CREATE TABLE hc_moves(room_id TEXT NOT NULL REFERENCES hc_rooms(id) ON DELETE CASCADE,
    ply INTEGER NOT NULL,at BIGINT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(room_id,ply))`,
  `CREATE TABLE hc_events(room_id TEXT NOT NULL REFERENCES hc_rooms(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,at BIGINT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(room_id,sequence))`,
  'CREATE TABLE hc_sessions(hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires BIGINT NOT NULL)',
  'CREATE INDEX hc_session_expiry ON hc_sessions(expires)',
  'CREATE TABLE hc_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
  'CREATE TABLE hc_audit(id TEXT PRIMARY KEY,at BIGINT NOT NULL,action TEXT NOT NULL,room TEXT)',
  'CREATE INDEX hc_audit_time ON hc_audit(at,id)'
] }, { version: 2, statements: [
  'ALTER TABLE hc_rooms ADD COLUMN computer_color TEXT',
  'ALTER TABLE hc_rooms ADD COLUMN computer_difficulty TEXT',
  'CREATE INDEX hc_room_computer ON hc_rooms(computer_color,phase)'
] }];
export async function migrate(database: Database) {
  await database.transaction(async tx => {
    if (database.kind === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(121237, 3)');
    await tx.query('CREATE TABLE IF NOT EXISTS hc_schema_migrations(version INTEGER PRIMARY KEY,applied_at BIGINT NOT NULL)');
    const applied = (await tx.query('SELECT version FROM hc_schema_migrations')).map(row => Number(row.version));
    if (applied.some(version => version > versions.at(-1)!.version)) throw new Error('database_schema_too_new');
    for (const change of versions) if (!applied.includes(change.version)) {
      for (const sql of change.statements) await tx.query(sql);
      await tx.query('INSERT INTO hc_schema_migrations VALUES($1,$2)', [change.version, Date.now()]);
    }
  });
}
