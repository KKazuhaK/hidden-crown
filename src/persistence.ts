import type { GameState, LogEvent } from './types';

export interface RoomSnapshot { state: GameState; events: LogEvent[] }
export interface RoomPersistence {
  load(): Promise<RoomSnapshot | undefined>;
  // Atomically replace the current-position snapshot and append only new moves/events.
  // expectedRevision rejects stale writers, including a close handler after deletion.
  commit(state: GameState, events: LogEvent[], expectedRevision: number): Promise<void>;
}
