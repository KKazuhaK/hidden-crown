import { describe, expect, it } from 'vitest';
import { initialPosition } from '../src/engine';
import { hiddenCrown } from '../src/rules/hidden-crown-v1';
import { hiddenCrown as currentRules } from '../src/rules/hidden-crown';
import { ruleRegistry } from '../src/rules/registry';
import { parseMessage, viewFor } from '../src/protocol';
import type { Color, GameCommand, GameState, PieceType } from '../src/types';

const sq = (name: string) => 'abcdefgh'.indexOf(name[0]) + (Number(name[1]) - 1) * 8;
describe('new rooms without undo', () => {
  it('only advertises and creates current rules while retaining old versions for existing rooms', () => {
    expect(ruleRegistry.selectionForCreation().version).toBe(4);
    expect(ruleRegistry.list().filter(r => r.id === 'hidden-crown').map(r => r.version)).toEqual([4]);
    for (const version of [1, 2, 3]) {
      expect(() => ruleRegistry.selectionForCreation({ id: 'hidden-crown', version })).toThrow('unsupported_ruleset');
      expect(ruleRegistry.resolve({ id: 'hidden-crown', version }).version).toBe(version);
    }
  });
  it('rejects requests and forged approvals in every phase, for either side, without changing state', () => {
    const state = game(); state.ruleset = ruleRegistry.selection(); state.crowns = { w: 'wQ', b: 'bQ' };
    for (const phase of ['lobby', 'crown_select', 'playing', 'ended'] as const) {
      state.phase = phase;
      const before = structuredClone(state);
      for (const color of ['w', 'b'] as const) {
        const view = viewFor(state, color, { w: true, b: true });
        expect(view.undoEnabled).toBe(false); expect(view.canRequestUndo).toBe(false);
        for (const command of [{ type: 'request_undo' }, { type: 'respond_undo', accept: true }, { type: 'respond_undo', accept: false }] as const)
          expect(currentRules.applyCommand(state, color, command, 5000)).toEqual({ error: 'undo_disabled' });
      }
      expect(state).toEqual(before);
    }
  });
  it('cannot undo a capture that exposes a crown candidate, and normal play continues', () => {
    const state = game({ wK: 'e1', wQ: 'd1', bK: 'e8', bQ: 'd8', bBc: 'd7' });
    state.ruleset = ruleRegistry.selection(); state.crowns = { w: 'wQ', b: 'bQ' };
    const result = currentRules.applyCommand(state, 'w', { type: 'move', from: sq('d1'), to: sq('d7') }, 2000);
    if ('error' in result) throw new Error(result.error);
    const captured = result.state, before = structuredClone(captured);
    expect(captured.moves.at(-1)?.captured).toBe('bBc'); expect(captured.phase).toBe('playing');
    expect(currentRules.applyCommand(captured, 'w', { type: 'request_undo' }, 3000)).toEqual({ error: 'undo_disabled' });
    expect(captured).toEqual(before);
    expect('state' in currentRules.applyCommand(captured, 'b', { type: 'move', from: sq('e8'), to: sq('f8') }, 4000)).toBe(true);
  });
});
function game(placements?: Record<string, string>): GameState {
  const position = initialPosition();
  if (placements) {
    position.pieces = {}; position.board.fill(null);
    for (const [id, name] of Object.entries(placements)) {
      const square = sq(name);
      position.pieces[id] = { id, color: id[0] as Color, type: id[1] as PieceType, square, hasMoved: false, promoted: false };
      position.board[square] = id;
    }
  }
  return { ...position, initialPosition: structuredClone(position), ruleState: {}, revision: 0, ruleset: { id: 'hidden-crown', version: 1, options: { castling: true, enPassant: true, drawPlyLimit: 100 } },
    roomId: 'UNDOTEST', createdAt: 0, phase: 'playing', moves: [], drawOffer: null, joined: { w: true, b: true }, claimed: { w: true, b: true },
    playStartedAt: 1000, lastMoveAt: null, result: null, crowns: { w: 'wK', b: 'bK' }, tokens: { w: 'white', b: 'black', observer: 'observer' } };
}
function command(state: GameState, color: Color, value: GameCommand, now = 10000) {
  const result = hiddenCrown.applyCommand(state, color, value, now);
  if ('error' in result) throw new Error(result.error);
  return result;
}
function move(state: GameState, from: string, to: string, promotion?: 'Q') {
  return command(state, state.turn, { type: 'move', from: sq(from), to: sq(to), ...(promotion ? { promotion } : {}) }, (state.lastMoveAt ?? 1000) + 1000).state;
}
function undo(state: GameState, color: Color) {
  return command(command(state, color, { type: 'request_undo' }).state, color === 'w' ? 'b' : 'w', { type: 'respond_undo', accept: true }, 20000);
}
describe('historical consensual undo', () => {
  it('validates strict messages and exposes capabilities without exposing crowns', () => {
    expect(parseMessage(JSON.stringify({ type: 'request_undo' }))).toEqual({ type: 'request_undo' });
    expect(parseMessage(JSON.stringify({ type: 'request_undo', targetPly: 0 }))).toBeNull();
    expect(parseMessage(JSON.stringify({ type: 'respond_undo', accept: 'yes' }))).toBeNull();
    const state = move(game(), 'e2', 'e4');
    expect(viewFor(state, 'w', { w: true, b: true }).canRequestUndo).toBe(true);
    expect(viewFor(state, 'b', { w: true, b: true }).canRequestUndo).toBe(false);
    expect(viewFor(state, 'w', { w: true, b: true }).crowns).toBeUndefined();
  });
  it('requires opponent approval, freezes moves and leaves rejected positions unchanged', () => {
    const state = move(game(), 'e2', 'e4'), requested = command(state, 'w', { type: 'request_undo' }).state;
    expect(hiddenCrown.applyCommand(requested, 'w', { type: 'respond_undo', accept: true }, 11000)).toEqual({ error: 'no_opponent_undo' });
    expect(hiddenCrown.applyCommand(requested, 'b', { type: 'move', from: sq('e7'), to: sq('e5') }, 11000)).toEqual({ error: 'undo_pending' });
    expect(hiddenCrown.applyCommand(requested, 'b', { type: 'request_undo' }, 11000)).toEqual({ error: 'undo_pending' });
    expect(viewFor(requested, 'b', { w: true, b: true }).legalMoves).toEqual([]);
    const rejected = command(requested, 'b', { type: 'respond_undo', accept: false });
    expect(rejected.state.board).toEqual(state.board); expect(rejected.state.moves).toEqual(state.moves);
    expect(rejected.events[0].type).toBe('undo_declined'); expect(rejected.state.undoRequest).toBeNull();
  });
  it('rewinds one or two plies, keeps locked crowns and resets think time', () => {
    const start = game(), once = move(start, 'e2', 'e4'), twice = move(once, 'e7', 'e5');
    for (const state of [once, twice]) {
      const accepted = undo(state, 'w');
      expect(accepted.state.board).toEqual(start.board); expect(accepted.state.pieces).toEqual(start.pieces);
      expect(accepted.state.moves).toHaveLength(0); expect(accepted.state.crowns).toEqual(start.crowns);
      expect(accepted.state.turn).toBe('w'); expect(accepted.state.lastMoveAt).toBeNull();
      expect(accepted.events[0].data?.removed).toEqual(state.moves);
      const next = command(accepted.state, 'w', { type: 'move', from: 12, to: 28 }, 21000).state;
      expect(next.moves[0].thinkMs).toBe(1000); expect(next.moves[0].ply).toBe(1);
    }
    expect(undo(twice, 'b').state.board).toEqual(once.board);
    expect(undo(twice, 'b').state.enPassant).toBe(once.enPassant);
    expect(undo(twice, 'b').state.moves).toEqual(once.moves);
  });
  it('restores castling rights, captures, promotion, en-passant and counters', () => {
    const castle = game({ wK: 'e1', wRh: 'h1', bK: 'e8' });
    expect(undo(move(castle, 'e1', 'g1'), 'w').state.pieces).toEqual(castle.pieces);
    const capture = game({ wK: 'a1', bK: 'h8', wRa: 'd1', bQ: 'd7' });
    expect(undo(move(capture, 'd1', 'd7'), 'w').state.pieces).toEqual(capture.pieces);
    const promotion = game({ wK: 'a1', bK: 'h6', wPa: 'a7' });
    expect(undo(move(promotion, 'a7', 'a8', 'Q'), 'w').state.pieces).toEqual(promotion.pieces);
    let ep = move(move(move(move(game(), 'e2', 'e4'), 'a7', 'a6'), 'e4', 'e5'), 'd7', 'd5');
    const restored = undo(move(ep, 'e5', 'd6'), 'w').state;
    expect(restored.board).toEqual(ep.board); expect(restored.pieces).toEqual(ep.pieces);
    expect(restored.enPassant).toBe(ep.enPassant); expect(restored.halfmoveClock).toBe(ep.halfmoveClock);
  });
  it('blocks undo before a move, during draw offers and after crown revelation; resignation remains possible', () => {
    expect(hiddenCrown.applyCommand(game(), 'w', { type: 'request_undo' }, 0)).toEqual({ error: 'undo_unavailable' });
    const state = move(game(), 'e2', 'e4');
    expect(hiddenCrown.applyCommand({ ...state, drawOffer: 'b' }, 'w', { type: 'request_undo' }, 0)).toEqual({ error: 'undo_unavailable' });
    expect(hiddenCrown.applyCommand({ ...state, phase: 'ended' }, 'w', { type: 'request_undo' }, 0)).toEqual({ error: 'wrong_phase' });
    const requested = command(state, 'w', { type: 'request_undo' }).state;
    const resigned = command(requested, 'b', { type: 'resign' }).state;
    expect(resigned.phase).toBe('ended'); expect(resigned.undoRequest).toBeNull();
  });
});
