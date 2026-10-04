import type { Color, GameState, Move, MoveRecord, Piece, PieceType, Promotion } from "./types";

export const opposite = (color: Color): Color => color === "w" ? "b" : "w";
export const squareName = (square: number): string => "abcdefgh"[square % 8] + (Math.floor(square / 8) + 1);
const diagonal = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const orthogonal = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const promotions: Promotion[] = ["Q", "R", "B", "N"];
const inside = (file: number, rank: number) => file >= 0 && file < 8 && rank >= 0 && rank < 8;

export function initialPosition(): Pick<GameState, "pieces" | "board" | "turn" | "ply" | "halfmoveClock" | "enPassant"> {
  const pieces: Record<string, Piece> = {};
  const board: (string | null)[] = Array(64).fill(null);
  const back: PieceType[] = ["R", "N", "B", "Q", "K", "B", "N", "R"];
  for (const color of ["w", "b"] as Color[]) {
    for (let file = 0; file < 8; file++) {
      for (const pawn of [false, true]) {
        const type = pawn ? "P" : back[file];
        const id = color + type + (type === "K" || type === "Q" ? "" : "abcdefgh"[file]);
        const rank = color === "w" ? (pawn ? 1 : 0) : (pawn ? 6 : 7);
        const square = rank * 8 + file;
        pieces[id] = { id, color, type, square, hasMoved: false, promoted: false };
        board[square] = id;
      }
    }
  }
  return { pieces, board, turn: "w", ply: 0, halfmoveClock: 0, enPassant: null };
}

export function pseudoLegalMoves(state: GameState, color: Color): Move[] {
  const moves: Move[] = [];
  for (const piece of Object.values(state.pieces)) {
    if (piece.color !== color || piece.square === null) continue;
    const from = piece.square, file = from % 8, rank = Math.floor(from / 8);
    const add = (to: number, extra: Partial<Move> = {}) => moves.push({ pieceId: piece.id, from, to, ...extra });
    const at = (to: number) => { const id = state.board[to]; return id ? state.pieces[id] : undefined; };
    const step = (df: number, dr: number, sliding = false) => {
      let f = file + df, r = rank + dr;
      while (inside(f, r)) {
        const to = r * 8 + f, target = at(to);
        if (target?.color === color) break;
        add(to);
        if (target || !sliding) break;
        f += df; r += dr;
      }
    };
    if (piece.type === "P") {
      const direction = color === "w" ? 1 : -1;
      const pawnAdd = (to: number, extra: Partial<Move> = {}) => {
        if (Math.floor(to / 8) === (color === "w" ? 7 : 0)) {
          for (const promotion of promotions) add(to, { ...extra, promotion });
        } else add(to, extra);
      };
      if (inside(file, rank + direction)) {
        const one = from + direction * 8;
        if (!at(one)) {
          pawnAdd(one);
          const two = from + direction * 16;
          if (rank === (color === "w" ? 1 : 6) && !at(two)) add(two);
        }
        for (const df of [-1, 1]) {
          if (!inside(file + df, rank + direction)) continue;
          const to = one + df, target = at(to);
          if (target && target.color !== color) pawnAdd(to);
          else if (!target && to === state.enPassant && color === state.turn && rank === (color === "w" ? 4 : 3)) {
            const victim = at(to - direction * 8);
            if (victim?.type === "P" && victim.color !== color) pawnAdd(to, { enPassant: true });
          }
        }
      }
    } else if (piece.type === "N") {
      for (const [df, dr] of [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]) step(df, dr);
    } else {
      const directions = piece.type === "B" ? diagonal : piece.type === "R" ? orthogonal : [...diagonal, ...orthogonal];
      for (const [df, dr] of directions) step(df, dr, piece.type !== "K");
      const base = color === "w" ? 0 : 56;
      if (piece.type === "K" && piece.id === color + "K" && from === base + 4 && !piece.hasMoved) {
        for (const castle of ["K", "Q"] as const) {
          const rook = state.pieces[color + (castle === "K" ? "Rh" : "Ra")];
          const rookSquare = base + (castle === "K" ? 7 : 0);
          const gaps = castle === "K" ? [5, 6] : [1, 2, 3];
          if (rook?.type === "R" && rook.color === color && rook.square === rookSquare && !rook.hasMoved && gaps.every(f => !state.board[base + f])) {
            add(base + (castle === "K" ? 6 : 2), { castle });
          }
        }
      }
    }
  }
  return moves;
}

// Compare all keys, including unexpected keys, independently of property order.
function sameMove(a: Move, b: Move): boolean {
  const aa = a as unknown as Record<string, unknown>, bb = b as unknown as Record<string, unknown>;
  return Object.keys(aa).length === Object.keys(bb).length && Object.keys(aa).every(key => aa[key] === bb[key]);
}

export function advancePosition(state: GameState, move: Move, now: number): { state: GameState; record: MoveRecord } {
  if (state.phase !== "playing" || state.result || !pseudoLegalMoves(state, state.turn).some(candidate => sameMove(candidate, move))) throw new Error("Illegal move");
  const next = structuredClone(state), piece = next.pieces[move.pieceId];
  const wasPawn = piece.type === "P", direction = piece.color === "w" ? 8 : -8;
  const captureSquare = move.enPassant ? move.to - direction : move.to;
  const captured = next.board[captureSquare] ?? undefined;
  if (captured) { next.pieces[captured].square = null; next.board[captureSquare] = null; }
  next.board[move.from] = null; next.board[move.to] = piece.id;
  piece.square = move.to; piece.hasMoved = true;
  if (move.castle) {
    const rook = next.pieces[piece.color + (move.castle === "K" ? "Rh" : "Ra")];
    next.board[rook.square!] = null;
    rook.square = (piece.color === "w" ? 0 : 56) + (move.castle === "K" ? 5 : 3);
    rook.hasMoved = true; next.board[rook.square] = rook.id;
  }
  const notation = move.castle ? (move.castle === "K" ? "O-O" : "O-O-O") :
    (wasPawn ? "" : piece.type) + squareName(move.from) + (captured ? "x" : "-") + squareName(move.to) +
    (move.promotion ? "=" + move.promotion : "") + (move.enPassant ? " e.p." : "");
  if (move.promotion) { piece.type = move.promotion; piece.promoted = true; }
  next.enPassant = wasPawn && Math.abs(move.to - move.from) === 16 ? (move.from + move.to) / 2 : null;
  next.halfmoveClock = captured || wasPawn ? 0 : state.halfmoveClock + 1;
  next.ply++; next.turn = opposite(state.turn); next.lastMoveAt = now; next.turnStartedAt = now; next.drawOffer = null;
  const record: MoveRecord = { ...move, ply: next.ply, color: state.turn, notation, at: now,
    thinkMs: Math.max(0, now - (state.turnStartedAt ?? state.lastMoveAt ?? state.playStartedAt ?? now)), ...(captured ? { captured } : {}) };
  next.moves.push(record);
  return { state: next, record };
}

// Retained for callers of the original engine. RoomCore dispatches through RuleSet.
export function applyMove(state: GameState, move: Move, now: number) {
  const applied = advancePosition(state, move, now);
  applied.state.result = checkEnd(applied.state, applied.record);
  if (applied.state.result) applied.state.phase = 'ended';
  return applied;
}

export function checkEnd(state: GameState, record: MoveRecord): GameState["result"] {
  if (record.captured && record.captured === state.crowns[opposite(record.color)]) return { winner: record.color, reason: "crown_captured" };
  if (state.halfmoveClock >= 100) return { winner: null, reason: "100_ply" };
  if (!pseudoLegalMoves(state, state.turn).length) return { winner: null, reason: "no_moves" };
  return null;
}
