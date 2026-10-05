import { describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { standardChess, drawClaim } from '../src/rules/standard-chess';
import { ruleRegistry } from '../src/rules/registry';
import { chessFor, positionKey, squareIndex } from '../src/rules/standard-position';
import { viewFor } from '../src/protocol';
import { chooseComputerMove } from '../src/computer/engine';
import { computerRequest } from '../src/computer/config';
// @ts-expect-error Browser modules intentionally ship as plain JavaScript.
import { replayAt } from '../public/js/replay.js';
import type { GameState, GameCommand, Color, PieceType } from '../src/types';

function game(fen?: string): GameState {
  const ruleset = ruleRegistry.selectionForCreation({ id: 'standard-chess', version: 1 }), position = standardChess.initialize(ruleset);
  const state: GameState = { ...position, revision: 1, ruleset, initialPosition: structuredClone(position), roomId: 'STANDARD', createdAt: 0,
    phase: 'playing', moves: [], drawOffer: null, joined: { w: true, b: true }, claimed: { w: true, b: true },
    playStartedAt: 0, lastMoveAt: null, result: null, crowns: { w: null, b: null }, tokens: { w: 'w-private', b: 'b-private', observer: 'admin-private' } };
  if (fen) {
    const chess = new Chess(fen); state.pieces = {}; state.board.fill(null);
    for (const row of chess.board()) for (const piece of row) if (piece) {
      const type = piece.type.toUpperCase() as PieceType, base = piece.color + type;
      const id = type === 'K' || type === 'Q' ? base : base + piece.square[0];
      state.pieces[id] = { id, color: piece.color, type, square: squareIndex(piece.square), hasMoved: true, promoted: false }; state.board[squareIndex(piece.square)] = id;
    }
    for (const color of ['w', 'b'] as const) {
      const rights = chess.getCastlingRights(color);
      if (rights.k || rights.q) state.pieces[color + 'K'].hasMoved = false;
      if (rights.k) state.pieces[color + 'Rh'].hasMoved = false;
      if (rights.q) state.pieces[color + 'Ra'].hasMoved = false;
    }
    const fields = fen.split(' '); state.turn = fields[1] as Color; state.enPassant = fields[3] === '-' ? null : squareIndex(fields[3]); state.halfmoveClock = Number(fields[4]);
    state.ply = (Number(fields[5]) - 1) * 2 + (state.turn === 'b' ? 1 : 0);
    state.ruleState = { repetitions: { [positionKey(chessFor(state))]: 1 } }; state.initialPosition = structuredClone({ pieces: state.pieces, board: state.board, turn: state.turn });
  }
  return state;
}
function action(state: GameState, command: GameCommand, color = state.turn) {
  const result = standardChess.applyCommand(state, color, command, (state.lastMoveAt ?? 0) + 1000);
  if ('error' in result) throw new Error(result.error); return result.state;
}
const move = (state: GameState, from: string, to: string, promotion?: 'Q' | 'N') => action(state, { type: 'move', from: squareIndex(from), to: squareIndex(to), ...(promotion ? { promotion } : {}) });

describe('standard chess isolated from Hidden Crown', () => {
  it('keeps Hidden Crown default and validates the standard creation contract', () => {
    expect(ruleRegistry.selectionForCreation().id).toBe('hidden-crown');
    expect(ruleRegistry.list().map(r => r.id)).toEqual(['hidden-crown', 'standard-chess']);
    expect(() => ruleRegistry.selectionForCreation({ id: 'standard-chess', version: 2 })).toThrow();
    expect(() => ruleRegistry.selectionForCreation({ id: 'standard-chess', version: 1, options: { castling: false } })).toThrow();
    expect(computerRequest({ humanColor: 'b', difficulty: 'easy' }, game().ruleset, () => 0).color).toBe('w');
  });
  it('starts when both players join without crown selection and timestamps play', () => {
    const state = game(); state.phase = 'lobby'; state.joined.b = false;
    standardChess.onPlayersJoined(state, 500); expect(state.phase).toBe('lobby');
    state.joined.b = true; standardChess.onPlayersJoined(state, 900);
    expect(state.phase).toBe('playing'); expect(state.playStartedAt).toBe(900); expect(state.turnStartedAt).toBe(900); expect(state.crowns).toEqual({ w: null, b: null });
  });
  it('matches opening perft counts while keeping original piece identities', () => {
    const start = game(), legal = standardChess.legalMoves(start, 'w'); expect(legal).toHaveLength(20);
    expect(legal.reduce((sum, m) => sum + standardChess.legalMoves(standardChess.applyMove(start, m, 1).state, 'b').length, 0)).toBe(400);
    const next = move(start, 'e2', 'e4'); expect(next.board[28]).toBe('wPe'); expect(next.moves[0].notation).toBe('e4'); expect(next.moves[0].thinkMs).toBe(1000);
    expect(start.board[12]).toBe('wPe');
  });
  it('enforces check, pins and king safety instead of capturing a king', () => {
    const pinned = game('k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1');
    expect(standardChess.legalMoves(pinned, 'w').some(m => m.from === 12 && m.to === 13)).toBe(false);
    const checked = game('k3r3/8/8/8/8/8/8/4K3 w - - 0 1');
    expect(viewFor(checked, 'w', { w: true, b: true }).inCheck).toBe(true);
    expect(standardChess.applyCommand(checked, 'w', { type: 'move', from: 4, to: 12 }, 1)).toEqual({ error: 'illegal_move' });
    const kings = game('8/8/8/8/8/4k3/8/4K3 w - - 0 1');
    expect(standardChess.legalMoves(kings, 'w').some(m => m.to === 12)).toBe(false);
  });
  it('checks castling attacks, including pawn attacks on empty transit squares', () => {
    const safe = game('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
    const castled = move(safe, 'e1', 'g1'); expect(castled.board[5]).toBe('wRh'); expect(castled.moves[0].notation).toBe('O-O');
    for (const fen of ['4k3/8/8/8/8/8/4p3/4K2R w K - 0 1', '4kr2/8/8/8/8/8/8/4K2R w K - 0 1', '4k3/8/8/8/8/8/8/4K2R w - - 0 1']) expect(standardChess.legalMoves(game(fen), 'w').some(m => m.castle)).toBe(false);
  });
  it('supports en passant and rejects it when it exposes the king', () => {
    let state = game(); for (const [from, to] of [['e2','e4'],['a7','a6'],['e4','e5'],['d7','d5']]) state = move(state, from, to);
    const ep = move(state, 'e5', 'd6'); expect(ep.pieces.bPd.square).toBeNull(); expect(ep.moves.at(-1)?.enPassant).toBe(true);
    const pinned = game('k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
    expect(standardChess.legalMoves(pinned, 'w').some(m => m.enPassant)).toBe(false);
  });
  it('offers four promotions, preserves identity, and replays promoted pieces', () => {
    const state = game('7k/P7/8/8/8/8/8/7K w - - 0 1');
    expect(standardChess.legalMoves(state, 'w').filter(m => m.from === 48)).toHaveLength(4);
    const promoted = move(state, 'a7', 'a8', 'N'); expect(promoted.pieces.wPa.type).toBe('N');
    expect(replayAt(viewFor(promoted, 'w', { w: true, b: true }), 1).pieces.wPa.type).toBe('N');
  });
  it('finishes Fool’s Mate, marks check and preserves both kings', () => {
    let state = game(); for (const [from, to] of [['f2','f3'],['e7','e5'],['g2','g4'],['d8','h4']]) state = move(state, from, to);
    expect(state.result).toEqual({ winner: 'b', reason: 'checkmate' }); expect(state.phase).toBe('ended'); expect(state.moves.at(-1)?.notation).toBe('Qh4#');
    expect(state.pieces.wK.square).toBe(4); expect(state.pieces.bK.square).toBe(60);
    const view = viewFor(state, 'w', { w: true, b: true }); expect(replayAt(view, 0).inCheck).toBe(false); expect(replayAt(view, 4).inCheck).toBe(true);
  });
  it('distinguishes stalemate and insufficient material from checkmate', () => {
    expect(move(game('k7/8/1QK5/8/8/8/8/8 w - - 0 1'), 'b6', 'c7').result?.reason).toBe('stalemate');
    expect(move(game('7k/8/8/8/8/8/4b3/4K3 w - - 0 1'), 'e1', 'e2').result?.reason).toBe('insufficient_material');
  });
  it('offers valid repetition claims, intended moves, and automatic fivefold repetition', () => {
    let state = game(); const cycle = [['g1','f3'],['g8','f6'],['f3','g1'],['f6','g8']];
    for (let i = 0; i < 7; i++) state = move(state, ...cycle[i % 4] as [string, string]);
    expect(drawClaim(state)?.move?.to).toBe(62);
    const declared = action(state, { type: 'rule_action', action: 'claim_draw', payload: { from: 45, to: 62 } }); expect(declared.result?.reason).toBe('threefold_repetition'); expect(declared.moves).toHaveLength(7);
    state = move(state, 'f6', 'g8'); expect(drawClaim(state)?.reason).toBe('threefold_repetition'); expect(state.phase).toBe('playing');
    const claimed = action(state, { type: 'rule_action', action: 'claim_draw', payload: {} }); expect(claimed.result?.reason).toBe('threefold_repetition');
    for (let i = 8; i < 16; i++) state = move(state, ...cycle[i % 4] as [string, string]);
    expect(state.result?.reason).toBe('fivefold_repetition');
  });
  it('separates 50-move claims from automatic 75 moves, prioritizes mate and resets on pawn moves', () => {
    const state = game('7k/8/8/8/8/8/8/KR6 w - - 99 50'); expect(drawClaim(state)?.reason).toBe('fifty_move');
    const hundred = move(state, 'b1', 'b2'); expect(hundred.phase).toBe('playing'); expect(drawClaim(hundred)?.reason).toBe('fifty_move');
    expect(move(game('7k/8/8/8/8/8/8/KR6 w - - 149 75'), 'b1', 'b2').result?.reason).toBe('seventy_five_move');
    expect(move(game('7k/8/5KQ1/8/8/8/8/8 w - - 149 75'), 'g6', 'g7').result?.reason).toBe('checkmate');
    expect(move({ ...game(), halfmoveClock: 99 }, 'e2', 'e4').halfmoveClock).toBe(0);
  });
  it('rejects forged claims, crowns, interrogations and undo without changing state', () => {
    const state = game(), original = structuredClone(state);
    for (const command of [{ type: 'select_crown', pieceId: 'wQ' }, { type: 'interrogate', targetId: 'bQ' }, { type: 'request_undo' }, { type: 'respond_undo', accept: true }, { type: 'rule_action', action: 'claim_draw', payload: {} }, { type: 'rule_action', action: 'claim_draw', payload: { from: 12, to: 28 } } ] as GameCommand[]) expect(standardChess.applyCommand(state, 'w', command, 10)).toHaveProperty('error');
    expect(state).toEqual(original); const view = viewFor(state, 'w', { w: true, b: true }); expect(view.interrogationsRemaining).toBeUndefined(); expect(view.undoEnabled).toBe(false);
  });
  it('standard computer chooses legal check responses in every difficulty without a crown', () => {
    const state = game('k3r3/8/8/8/8/8/8/4K3 w - - 0 1');
    for (const difficulty of ['easy','medium','hard'] as const) {
      const input = { ...state, color: state.turn, difficulty, ownCrown: null };
      const result = chooseComputerMove(input, () => .2); expect(standardChess.legalMoves(state, 'w')).toContainEqual(result.move); expect(result.targetId).toBeUndefined();
    }
    const state2 = game('7k/8/5KQ1/8/8/8/8/8 w - - 0 1');
    const result = chooseComputerMove({ ...state2, color: 'w', difficulty: 'medium', ownCrown: null });
    expect(standardChess.applyMove(state2, result.move!, 1).state.result?.reason).toBe('checkmate');
  });
  it('translates beginner rules and terminal reasons in both languages', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    // @ts-expect-error Browser modules intentionally ship as plain JavaScript.
    const i18n = await import('../public/js/i18n.js');
    for (let language = 0; language < 2; language++) {
      for (const key of ['standardMode', 'standardModeHelp', 'checkmate', 'stalemate', 'claimDraw', ...Array.from({ length: 10 }, (_, i) => `standard_rule${i + 1}`)]) expect(i18n.t(key)).not.toEqual(i18n.t('error_request'));
      i18n.toggleLanguage();
    }
  });
});
