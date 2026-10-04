import type { GameState, LogEvent } from './types';

export interface RoomSnapshot { state: GameState; events: LogEvent[] }
export interface RoomPersistence {
  load(): Promise<RoomSnapshot | undefined>;
  // Atomically replace the position and update move history. Accepted undo trims
  // active moves while retaining the original moves and undo in the event audit.
  // expectedRevision rejects stale writers, including a close handler after deletion.
  commit(state: GameState, events: LogEvent[], expectedRevision: number): Promise<void>;
}
