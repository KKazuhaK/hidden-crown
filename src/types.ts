export type Color = "w" | "b";
export type Role = Color | "observer";
export type PieceType = "K" | "Q" | "R" | "B" | "N" | "P";
export type Promotion = "Q" | "R" | "B" | "N";
export type Square = number;
export type Phase = "lobby" | "crown_select" | "playing" | "ended";
export type Difficulty = 'easy' | 'medium' | 'hard';
export interface ComputerConfig { color: Color; difficulty: Difficulty }
export interface UndoRequest { color: Color; targetPly: number }
export interface Piece {
  id: string;
  color: Color;
  type: PieceType;
  square: Square | null;
  hasMoved: boolean;
  promoted: boolean;
}
export interface Move {
  pieceId: string;
  from: Square;
  to: Square;
  promotion?: Promotion;
  castle?: "K" | "Q";
  enPassant?: boolean;
}
export interface MoveRecord extends Move {
  kind?: 'interrogation';
  targetId?: string;
  targetSquare?: Square;
  // Equal-length private values prevent storage admission from leaking answers.
  answer?: 'crown' | 'clear';
  ply: number;
  color: Color;
  captured?: string;
  notation: string;
  at: number;
  thinkMs: number;
}
export interface GameState {
  undoRequest?: UndoRequest | null;
  turnStartedAt?: number;
  computer?: ComputerConfig;
  revision: number;
  ruleset: RuleSelection;
  initialPosition: InitialPosition;
  ruleState: Record<string, unknown>;
  roomId: string;
  createdAt: number;
  phase: Phase;
  pieces: Record<string, Piece>;
  board: (string | null)[];
  turn: Color;
  ply: number;
  halfmoveClock: number;
  enPassant: Square | null;
  moves: MoveRecord[];
  drawOffer: Color | null;
  joined: { w: boolean; b: boolean };
  claimed: { w: boolean; b: boolean };
  playStartedAt: number | null;
  lastMoveAt: number | null;
  result: null | { winner: Color | null; reason: "crown_captured" | "resign" | "no_moves" | "agreement" | "100_ply" | "move_limit" | "admin" };
  crowns: { w: string | null; b: string | null };
  tokens: { w: string; b: string; observer: string };
}
export interface LogEvent {
  t: number;
  actor: Role | "system" | "admin";
  type: "room_created" | "seat_claimed" | "joined" | "left" | "crown_locked" | "play_started" | "move" | "interrogation" | "draw_offered" | "draw_declined" | "draw_accepted" | "undo_requested" | "undo_declined" | "undo_accepted" | "resign" | "game_ended" | "rule_action";
  data?: Record<string, unknown>;
}
export interface View {
  undoRequest?: UndoRequest | null;
  turnStartedAt?: number;
  canRequestUndo?: boolean;
  computer?: ComputerConfig;
  revision: number;
  ruleset: RuleSelection;
  initialPosition: InitialPosition;
  role: Role;
  phase: Phase;
  pieces: GameState["pieces"];
  board: GameState["board"];
  turn: Color;
  moves: MoveRecord[];
  connected: { w: boolean; b: boolean };
  playStartedAt: number | null;
  lastMoveAt: number | null;
  serverNow: number;
  crownLocked: { w: boolean; b: boolean };
  drawOffer: Color | null;
  result: GameState["result"];
  yourCrown?: string;
  crowns?: GameState["crowns"];
  legalMoves?: Move[];
  interrogationTargets?: string[];
  interrogationsRemaining?: { w: number; b: number };
}
export interface Links { white: string; black: string; observer: string }
export interface RuleSelection { id: string; version: number; options: Record<string, unknown> }
export type InitialPosition = Pick<GameState, "pieces" | "board" | "turn">;
export type GameCommand =
  | { type: 'select_crown'; pieceId: string }
  | { type: 'move'; from: number; to: number; promotion?: Promotion }
  | { type: 'interrogate'; targetId: string }
  | { type: 'respond_draw' | 'respond_undo'; accept: boolean }
  | { type: 'offer_draw' | 'resign' | 'request_undo' }
  | { type: 'rule_action'; action: string; payload: Record<string, unknown> };
