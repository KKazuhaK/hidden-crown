import { describe, expect, it } from "vitest";
import { applyMove, checkEnd, initialPosition, pseudoLegalMoves } from "../src/engine";
import { parseMessage, viewFor } from "../src/protocol";
import type { Color, GameState, Move, MoveRecord, PieceType } from "../src/types";

const sq = (name: string) => "abcdefgh".indexOf(name[0]) + (Number(name[1]) - 1) * 8;
export function setup(placements?: Record<string, string>, turn: Color = "w"): GameState {
  const state: GameState = {
    ...initialPosition(), roomId: "TESTROOM", createdAt: 0, phase: "playing", moves: [], drawOffer: null,
    joined: { w: true, b: true }, claimed: { w: true, b: true }, playStartedAt: 1000, lastMoveAt: null, result: null,
    crowns: { w: null, b: null }, tokens: { w: "white-secret", b: "black-secret", observer: "observer-secret" }, turn
  };
  if (placements) {
    state.pieces = {}; state.board.fill(null);
    for (const [id, name] of Object.entries(placements)) {
      const square = sq(name);
      state.pieces[id] = { id, color: id[0] as Color, type: id[1] as PieceType, square, hasMoved: false, promoted: false };
      state.board[square] = id;
    }
  }
  return state;
}
const moveFor = (s: GameState, from: string, to: string, promotion?: Move["promotion"]) => {
  const move = pseudoLegalMoves(s, s.turn).find(m => m.from === sq(from) && m.to === sq(to) && m.promotion === promotion);
  expect(move, `${from}-${to}`).toBeDefined(); return move!;
};
const play = (s: GameState, from: string, to: string, promotion?: Move["promotion"]) => applyMove(s, moveFor(s, from, to, promotion), (s.lastMoveAt ?? 1000) + 1500);
const dummy: MoveRecord = { pieceId: "bQ", from: 59, to: 51, ply: 1, color: "b", notation: "Qd8-d7", at: 2000, thinkMs: 1000 };

describe("Hidden Crown pseudo-legal engine", () => {
  it("has exactly 20 opening moves for either side", () => {
    expect(pseudoLegalMoves(setup(), "w")).toHaveLength(20);
    expect(pseudoLegalMoves(setup(), "b")).toHaveLength(20);
  });
  it("allows kings on attacked squares and adjacent kings", () => {
    const state = setup({ wK: "e1", bRa: "e8", bK: "g2" });
    expect(pseudoLegalMoves(state, "w").some(m => m.to === sq("e2"))).toBe(true);
    expect(pseudoLegalMoves(state, "w").some(m => m.to === sq("f2"))).toBe(true);
  });
  it("allows both castles through attacked squares and moves the original rook", () => {
    const state = setup({ wK: "e1", wRh: "h1", wRa: "a1", bRa: "f8", bK: "e8" });
    expect(pseudoLegalMoves(state, "w").filter(m => m.castle).map(m => m.castle)).toEqual(["K", "Q"]);
    const { state: next, record } = play(state, "e1", "g1");
    expect(record.notation).toBe("O-O");
    expect(next.pieces.wRh).toMatchObject({ square: sq("f1"), hasMoved: true });
    expect(next.pieces.wK).toMatchObject({ square: sq("g1"), hasMoved: true });
    expect(state.pieces.wK.square).toBe(sq("e1"));
  });
  it.each(["occupied", "king_moved", "rook_moved", "rook_captured", "king_captured"])("forbids castling: %s", condition => {
    const state = setup({ wK: "e1", wRh: "h1", bK: "e8" });
    if (condition === "occupied") { state.pieces.wBf = { id: "wBf", color: "w", type: "B", square: sq("f1"), hasMoved: false, promoted: false }; state.board[sq("f1")] = "wBf"; }
    if (condition === "king_moved") state.pieces.wK.hasMoved = true;
    if (condition === "rook_moved") state.pieces.wRh.hasMoved = true;
    if (condition === "rook_captured") { state.pieces.wRh.square = null; state.board[sq("h1")] = null; }
    if (condition === "king_captured") { state.pieces.wK.square = null; state.board[sq("e1")] = null; }
    expect(pseudoLegalMoves(state, "w").some(m => m.castle)).toBe(false);
  });
  it("requires the b-file gap for queenside castling, for both colors", () => {
    const state = setup({ wK: "e1", wRa: "a1", wNb: "b1", bK: "e8", bRa: "a8" }, "b");
    expect(pseudoLegalMoves(state, "w").some(m => m.castle)).toBe(false);
    const { state: next, record } = play(state, "e8", "c8");
    expect(record.notation).toBe("O-O-O"); expect(next.board[sq("d8")]).toBe("bRa");
  });
  it("allows en passant only immediately after a double pawn push", () => {
    let state = setup({ wPe: "e5", wK: "a1", bPd: "d7", bK: "h8" }, "b");
    state = play(state, "d7", "d5").state;
    expect(state.enPassant).toBe(sq("d6"));
    const captured = play(state, "e5", "d6");
    expect(captured.record).toMatchObject({ enPassant: true, captured: "bPd", notation: "e5xd6 e.p." });
    expect(captured.state.board[sq("d5")]).toBeNull(); expect(captured.state.pieces.bPd.square).toBeNull();
    state = play(state, "a1", "a2").state;
    state = play(state, "h8", "h7").state;
    expect(state.enPassant).toBeNull();
    expect(pseudoLegalMoves(state, "w").some(m => m.enPassant)).toBe(false);
  });
  it("implements black en passant with the correct capture square", () => {
    let state = setup({ wPd: "d2", wK: "a1", bPe: "e4", bK: "h8" });
    state = play(state, "d2", "d4").state;
    const { state: next, record } = play(state, "e4", "d3");
    expect(record.captured).toBe("wPd"); expect(next.board[sq("d4")]).toBeNull();
  });
  it("generates four promotions and retains the permanent pawn ID", () => {
    const state = setup({ wPe: "e7", wK: "a1", bK: "h8" });
    expect(pseudoLegalMoves(state, "w").filter(m => m.pieceId === "wPe").map(m => m.promotion)).toEqual(["Q", "R", "B", "N"]);
    for (const type of ["Q", "R", "B", "N"] as const) {
      const { state: next, record } = play(state, "e7", "e8", type);
      expect(next.pieces.wPe).toMatchObject({ id: "wPe", type, promoted: true });
      expect(record.notation).toBe(`e7-e8=${type}`);
    }
  });
  it("handles capture promotion for black", () => {
    const state = setup({ wRa: "a1", wK: "h1", bPb: "b2", bK: "h8" }, "b");
    const { state: next, record } = play(state, "b2", "a1", "N");
    expect(record).toMatchObject({ notation: "b2xa1=N", captured: "wRa" });
    expect(next.pieces.bPb.type).toBe("N");
  });
  it("never wraps a knight on h4 onto the a or b files", () => {
    const moves = pseudoLegalMoves(setup({ wNg: "h4" }), "w");
    expect(moves).toHaveLength(4); expect(moves.every(m => m.to % 8 > 1)).toBe(true);
  });
  it.each(["bK", "bNg"])("capturing non-crown %s does not end a playable game", victim => {
    const state = setup({ wQ: "d1", [victim]: "h5", bRa: "a8" }); state.crowns.b = "bRa";
    const { state: next, record } = play(state, "d1", "h5");
    expect(record.notation).toBe("Qd1xh5"); expect(next.result).toBeNull(); expect(next.pieces[victim].square).toBeNull();
  });
  it("crown capture wins immediately, ahead of no-moves draw", () => {
    const state = setup({ wQ: "d1", bK: "h5" }); state.crowns.b = "bK";
    const next = play(state, "d1", "h5").state;
    expect(next.result).toEqual({ winner: "w", reason: "crown_captured" }); expect(next.phase).toBe("ended");
  });
  it("applies the 100-ply draw and clears a draw offer on moving", () => {
    const state = setup({ wK: "a1", bK: "h8" }); state.halfmoveClock = 99; state.drawOffer = "b";
    const { state: next, record } = play(state, "a1", "a2");
    expect(next.result).toEqual({ winner: null, reason: "100_ply" }); expect(next.drawOffer).toBeNull();
    expect(record).toMatchObject({ at: 2500, thinkMs: 1500, ply: 1 });
  });
  it("resets the halfmove counter for a capture or pawn move", () => {
    const state = setup({ wK: "a1", wPa: "a2", wQ: "d1", bNg: "h5", bK: "h8" }); state.halfmoveClock = 99;
    expect(play(state, "d1", "h5").state.halfmoveClock).toBe(0);
    expect(play(state, "a2", "a3").state.halfmoveClock).toBe(0);
  });
  it("detects the specified blocked bishop and pawns no-moves draw", () => {
    const state = setup({ wBc: "c1", wPb: "b2", wPd: "d2", bPb: "b3", bPd: "d3" });
    expect(pseudoLegalMoves(state, "w")).toEqual([]);
    expect(checkEnd(state, dummy)).toEqual({ winner: null, reason: "no_moves" });
  });
  it("rejects invalid, wrong-color, incomplete special, and forged moves", () => {
    const state = setup();
    expect(() => applyMove(state, { pieceId: "wPe", from: sq("e2"), to: sq("e5") }, 2000)).toThrow();
    expect(() => applyMove(state, { pieceId: "bPe", from: sq("e7"), to: sq("e5") }, 2000)).toThrow();
    const valid = moveFor(state, "e2", "e4");
    expect(() => applyMove(state, { ...valid, captured: "bK" } as Move, 2000)).toThrow();
    const castle = setup({ wK: "e1", wRh: "h1", bK: "e8" });
    expect(() => applyMove(castle, { pieceId: "wK", from: sq("e1"), to: sq("g1") }, 2000)).toThrow();
  });
  it("stops sliders at blockers and does not capture own pieces", () => {
    const state = setup({ wRa: "a1", wPa: "a3", bPb: "c1", bK: "h8" });
    const targets = pseudoLegalMoves(state, "w").filter(m => m.pieceId === "wRa").map(m => m.to);
    expect(targets).toContain(sq("c1")); expect(targets).not.toContain(sq("d1")); expect(targets).not.toContain(sq("a3"));
  });
  it("maintains board/piece consistency through a deterministic long game", () => {
    let state = setup(); let seed = 7;
    for (let i = 0; i < 200 && !state.result; i++) {
      const moves = pseudoLegalMoves(state, state.turn); seed = (seed * 1664525 + 1013904223) >>> 0;
      state = applyMove(state, moves[seed % moves.length], 1000 + i * 100).state;
      expect(state.board.filter(Boolean)).toHaveLength(Object.values(state.pieces).filter(p => p.square !== null).length);
      for (const piece of Object.values(state.pieces)) if (piece.square !== null) expect(state.board[piece.square]).toBe(piece.id);
      expect(state.moves.at(-1)?.notation).not.toMatch(/[+#]/);
    }
  });
});

describe("privacy and input boundaries", () => {
  it("produces identical white views for different opposing crown choices", () => {
    const state = setup(); state.crowns = { w: "wK", b: "bK" };
    const view = viewFor(state, "w", { w: true, b: true }, 3000);
    state.crowns.b = "bQ";
    expect(viewFor(state, "w", { w: true, b: true }, 3000)).toEqual(view);
    expect(view).not.toHaveProperty("crowns"); expect(view).not.toHaveProperty("tokens");
    expect(view.yourCrown).toBe("wK"); expect(view.legalMoves).toHaveLength(20);
    expect(viewFor(state, "b", { w: true, b: true })).not.toHaveProperty("legalMoves");
  });
  it("reveals both crowns to observers and to players only after ending", () => {
    const state = setup(); state.crowns = { w: "wK", b: "bQ" };
    expect(viewFor(state, "observer", { w: false, b: false }).crowns).toEqual(state.crowns);
    state.phase = "ended";
    expect(viewFor(state, "w", { w: false, b: false }).crowns).toEqual(state.crowns);
  });
  it("rejects malformed and extra client fields", () => {
    for (const raw of ['null', '[]', '{', '{"type":"move","from":-1,"to":2}', '{"type":"move","from":1,"to":2,"promotion":"K"}', '{"type":"resign","crowns":{}}', '{"type":"respond_draw","accept":"yes"}']) expect(parseMessage(raw)).toBeNull();
    expect(parseMessage('{"type":"move","from":12,"to":28}')).toEqual({ type: "move", from: 12, to: 28 });
  });
});
