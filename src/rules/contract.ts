import type { Color, GameCommand, GameState, LogEvent, Move, MoveRecord, RuleSelection } from '../types';

// Rule implementations are trusted code registered at build time, never scripts from a request.
// Network authentication, room ownership, persistence and hidden-data redaction stay outside them.
export interface RuleSet {
  readonly id: string;
  readonly version: number;
  readonly name: { en: string; zh: string };
  normalizeOptions(input: unknown): Record<string, unknown>;
  initialize(selection: RuleSelection): Pick<GameState, 'pieces' | 'board' | 'turn' | 'ply' | 'halfmoveClock' | 'enPassant' | 'ruleState'>;
  onPlayersJoined(state: GameState, now: number): void;
  applyCommand(state: GameState, color: Color, command: GameCommand, now: number): { state: GameState; events: LogEvent[] } | { error: string };
  legalMoves(state: GameState, color: Color): Move[];
  canRequestUndo?(state: GameState, color: Color): boolean;
  interrogationTargets?(state: GameState, color: Color): string[];
  applyMove(state: GameState, move: Move, now: number): { state: GameState; record: MoveRecord };
}
