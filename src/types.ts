export type Color = "w" | "b";
export type Role = Color | "observer";
export type PieceType = "K" | "Q" | "R" | "B" | "N" | "P";
export type Promotion = "Q" | "R" | "B" | "N";
export type Square = number;
export type Phase = "lobby" | "crown_select" | "playing" | "ended";
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
  ply: number;
  color: Color;
  captured?: string;
  notation: string;
  at: number;
  thinkMs: number;
}
export interface GameState {
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
  result: null | { winner: Color | null; reason: "crown_captured" | "resign" | "no_moves" | "agreement" | "100_ply" | "admin" };
  crowns: { w: string | null; b: string | null };
  tokens: { w: string; b: string; observer: string };
}
export interface LogEvent {
  t: number;
  actor: Role | "system" | "admin";
  type: "room_created" | "seat_claimed" | "joined" | "left" | "crown_locked" | "play_started" | "move" | "draw_offered" | "draw_declined" | "draw_accepted" | "resign" | "game_ended";
  data?: Record<string, unknown>;
}
export interface View {
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
}
export interface Links { white: string; black: string; observer: string }
