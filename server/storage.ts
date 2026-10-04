import { randomUUID } from 'node:crypto';
import type { GameState, LogEvent, MoveRecord } from '../src/types';
import type { RoomSnapshot } from '../src/persistence';
import type { Database, Queryable, SqlRow } from './database/contract';
import { migrate } from './database/migrations';

export interface RoomSummary { id: string; created_at: number; phase: string; ply: number; bytes: number; ruleset_id: string; ruleset_version: number; computer_color: string | null; computer_difficulty: string | null }
function summary(row: SqlRow): RoomSummary {
  return { id: String(row.id), created_at: Number(row.created_at), phase: String(row.phase), ply: Number(row.ply), bytes: Number(row.bytes), ruleset_id: String(row.ruleset_id), ruleset_version: Number(row.ruleset_version), computer_color: row.computer_color ? String(row.computer_color) : null, computer_difficulty: row.computer_difficulty ? String(row.computer_difficulty) : null };
}
function encodeSnapshot(state: Omit<GameState, 'moves'>) {
  // Keep private crown choices equal-sized even for IDs such as wK versus wRh.
  // Storage/cache admission must not change according to which crown was chosen.
  const value = { ...state, crowns: { ...state.crowns } };
  for (const color of ['w', 'b'] as const) if (value.crowns[color]) value.crowns[color] = value.crowns[color]!.padEnd(16, ' ');
  return JSON.stringify(value);
}
function encodeEvent(event: LogEvent) {
  return JSON.stringify(event.type === 'crown_locked' && typeof event.data?.pieceId === 'string'
    ? { ...event, data: { ...event.data, pieceId: event.data.pieceId.padEnd(16, ' ') } } : event);
}
function decodeEvent(data: string) {
  const event = JSON.parse(data) as LogEvent;
  if (event.type === 'crown_locked' && typeof event.data?.pieceId === 'string') event.data.pieceId = event.data.pieceId.trimEnd();
  return event;
}

export class Store {
  constructor(readonly database: Database, private maxRoomBytes: number) {}
  async initialize() { await migrate(this.database); }
  async header(id: string) { const row = (await this.database.query('SELECT id,created_at,phase,ply,bytes,ruleset_id,ruleset_version,computer_color,computer_difficulty FROM hc_rooms WHERE id=$1', [id]))[0]; return row ? summary(row) : undefined; }
  async load(id: string): Promise<RoomSnapshot | undefined> {
    return this.database.transaction(async tx => {
      // Lock the snapshot through all history reads so they cannot straddle a commit.
      const row = (await tx.query(`SELECT state FROM hc_rooms WHERE id=$1${this.database.kind === 'postgres' ? ' FOR SHARE' : ''}`, [id]))[0];
      if (!row) return undefined;
      const state = JSON.parse(String(row.state)) as GameState;
      for (const color of ['w', 'b'] as const) if (state.crowns[color]) state.crowns[color] = state.crowns[color]!.trimEnd();
      state.moves = (await tx.query('SELECT data FROM hc_moves WHERE room_id=$1 ORDER BY ply', [id])).map(value => JSON.parse(String(value.data)) as MoveRecord);
      const events = (await tx.query('SELECT data FROM hc_events WHERE room_id=$1 ORDER BY sequence', [id])).map(value => decodeEvent(String(value.data)));
      if (state.moves.length !== state.ply) throw new Error('room_history_inconsistent');
      return { state, events };
    });
  }
  async commit(state: GameState, events: LogEvent[], expectedRevision: number, validate?: (bytes: number) => void) {
    const { moves, ...snapshot } = state;
    const json = encodeSnapshot(snapshot), snapshotBytes = Buffer.byteLength(json);
    return this.database.transaction(async tx => {
      const old = (await tx.query(`SELECT revision,ply,event_count,history_bytes,ruleset_id,ruleset_version,state FROM hc_rooms WHERE id=$1${this.database.kind === 'postgres' ? ' FOR UPDATE' : ''}`, [state.roomId]))[0];
      if ((!old && expectedRevision !== 0) || (old && Number(old.revision) !== expectedRevision) || state.revision !== expectedRevision + 1) throw new Error('room_conflict');
      if (old && (old.ruleset_id !== state.ruleset.id || Number(old.ruleset_version) !== state.ruleset.version)) throw new Error('room_ruleset_immutable');
      if (old && JSON.stringify(JSON.parse(String(old.state)).ruleset.options) !== JSON.stringify(state.ruleset.options)) throw new Error('room_ruleset_immutable');
      if (old && JSON.stringify(JSON.parse(String(old.state)).computer) !== JSON.stringify(state.computer)) throw new Error('room_computer_immutable');
      const previousPly = Number(old?.ply ?? 0), previousEvents = Number(old?.event_count ?? 0);
      if (state.ply !== moves.length || state.ply > previousPly + 64 || events.length > 64) throw new Error('room_history_inconsistent');
      let removedBytes = 0;
      const rewind = state.ply < previousPly;
      if (rewind) {
        const prior = JSON.parse(String(old!.state)) as GameState, request = prior.undoRequest, accepted = events[0];
        if (prior.phase !== 'playing' || state.phase !== 'playing' || !request || state.undoRequest || events.length !== 1 ||
            accepted.type !== 'undo_accepted' || accepted.actor !== (request.color === 'w' ? 'b' : 'w') ||
            request.targetPly !== state.ply || accepted.data?.targetPly !== state.ply || previousPly - state.ply > 2)
          throw new Error('room_history_inconsistent');
        const history = await tx.query('SELECT data FROM hc_moves WHERE room_id=$1 ORDER BY ply', [state.roomId]);
        if (history.slice(state.ply).some(row => JSON.parse(String(row.data)).kind === 'interrogation')) throw new Error('room_history_inconsistent');
        if (JSON.stringify(history.slice(0, state.ply).map(row => JSON.parse(String(row.data)))) !== JSON.stringify(moves) ||
            JSON.stringify(history.slice(state.ply).map(row => JSON.parse(String(row.data)))) !== JSON.stringify(accepted.data?.removed))
          throw new Error('room_history_inconsistent');
        removedBytes = history.slice(state.ply).reduce((total, row) => total + Buffer.byteLength(String(row.data)), 0);
      }
      const basePly = rewind ? state.ply : previousPly;
      const appended = moves.slice(basePly).map(move => ({ value: move, data: JSON.stringify(move) }));
      if (appended.some((row, index) => row.value.ply !== basePly + index + 1)) throw new Error('room_history_inconsistent');
      const addedEvents = events.map(value => ({ value, data: encodeEvent(value) }));
      const historyBytes = Number(old?.history_bytes ?? 0) - removedBytes + [...appended, ...addedEvents].reduce((total, row) => total + Buffer.byteLength(row.data), 0);
      const bytes = snapshotBytes + historyBytes;
      if (bytes > this.maxRoomBytes) throw new Error('room_storage_limit');
      validate?.(bytes);
      const values = [json, state.revision, state.createdAt, state.phase, state.ply, bytes, historyBytes, previousEvents + events.length, state.ruleset.id, state.ruleset.version, state.roomId, state.computer?.color ?? null, state.computer?.difficulty ?? null];
      if (rewind) await tx.query('DELETE FROM hc_moves WHERE room_id=$1 AND ply>$2', [state.roomId, state.ply]);
      if (old) await tx.query('UPDATE hc_rooms SET state=$1,revision=$2,created_at=$3,phase=$4,ply=$5,bytes=$6,history_bytes=$7,event_count=$8,ruleset_id=$9,ruleset_version=$10,computer_color=$12,computer_difficulty=$13 WHERE id=$11', values);
      else await tx.query('INSERT INTO hc_rooms(state,revision,created_at,phase,ply,bytes,history_bytes,event_count,ruleset_id,ruleset_version,id,computer_color,computer_difficulty) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', values);
      for (const move of appended) await tx.query('INSERT INTO hc_moves VALUES($1,$2,$3,$4)', [state.roomId, move.value.ply, move.value.at, move.data]);
      for (let index = 0; index < addedEvents.length; index++) {
        const event = addedEvents[index];
        await tx.query('INSERT INTO hc_events VALUES($1,$2,$3,$4)', [state.roomId, previousEvents + index + 1, event.value.t, event.data]);
      }
      return bytes;
    });
  }
  async count() { return Number((await this.database.query('SELECT COUNT(*) AS n FROM hc_rooms'))[0].n); }
  async usage() {
    const row = (await this.database.query(`SELECT COUNT(*) AS rooms,COALESCE(SUM(bytes),0) AS bytes,
      COALESCE(SUM(CASE WHEN phase<>'ended' THEN 1 ELSE 0 END),0) AS active FROM hc_rooms`))[0];
    return { rooms: Number(row.rooms), bytes: Number(row.bytes), active: Number(row.active) };
  }
  async list(page: number) { return (await this.database.query('SELECT id,created_at,phase,ply,bytes,ruleset_id,ruleset_version,computer_color,computer_difficulty FROM hc_rooms ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET $1', [(page - 1) * 50])).map(summary); }
  async computerCount() { return Number((await this.database.query("SELECT COUNT(*) AS n FROM hc_rooms WHERE computer_color IS NOT NULL AND phase<>'ended'"))[0].n); }
  async expired(before: number) { return (await this.database.query("SELECT id FROM hc_rooms WHERE phase IN ('lobby','crown_select') AND created_at<=$1 ORDER BY created_at LIMIT 100", [before])).map(row => String(row.id)); }
  async metadata(key: string) { const row = (await this.database.query('SELECT value FROM hc_metadata WHERE key=$1', [key]))[0]; return row ? String(row.value) : undefined; }
  async setMetadata(key: string, value: string) { await this.database.query('INSERT INTO hc_metadata VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, value]); }
  async audit(action: string, room: string | null = null, tx: Queryable = this.database) {
    await tx.query('INSERT INTO hc_audit VALUES($1,$2,$3,$4)', [randomUUID(), Date.now(), action, room]);
    await tx.query('DELETE FROM hc_audit WHERE id IN (SELECT id FROM hc_audit ORDER BY at DESC,id DESC LIMIT 1000 OFFSET 10000)');
  }
  async delete(id: string, before?: number) {
    return this.database.transaction(async tx => {
      const suffix = before === undefined ? '' : " AND phase IN ('lobby','crown_select') AND created_at<=$2";
      const deleted = await tx.query(`DELETE FROM hc_rooms WHERE id=$1${suffix} RETURNING id`, before === undefined ? [id] : [id, before]);
      if (!deleted.length) return false;
      await tx.query('DELETE FROM hc_audit WHERE room=$1', [id]);
      await this.audit(before === undefined ? 'room_deleted' : 'room_expired', null, tx); return true;
    });
  }
  async session(hash: string) { const row = (await this.database.query('SELECT csrf,expires FROM hc_sessions WHERE hash=$1 AND expires>$2', [hash, Date.now()]))[0]; return row ? { hash, csrf: String(row.csrf), expires: Number(row.expires) } : null; }
  async addSession(hash: string, csrf: string, expires: number) {
    await this.database.transaction(async tx => {
      if (this.database.kind === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(121237, 4)');
      await tx.query('DELETE FROM hc_sessions WHERE expires<=$1', [Date.now()]);
      if (Number((await tx.query('SELECT COUNT(*) AS n FROM hc_sessions'))[0].n) >= 32) throw new Error('session_limit');
      await tx.query('INSERT INTO hc_sessions VALUES($1,$2,$3)', [hash, csrf, expires]);
      await this.audit('login', null, tx);
    });
  }
  async deleteSession(hash: string) { await this.database.query('DELETE FROM hc_sessions WHERE hash=$1', [hash]); }
  async revokeSessions() { await this.database.query('DELETE FROM hc_sessions'); }
  async health() { await this.database.query('SELECT 1'); }
  async close() { await this.database.close(); }
}
