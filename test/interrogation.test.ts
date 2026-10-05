import { describe, expect, it } from 'vitest';
import { initialPosition } from '../src/engine';
import { hiddenCrown, interrogationTargets, crownCandidate } from '../src/rules/hidden-crown';
import { ruleRegistry } from '../src/rules/registry';
import { viewFor, parseMessage } from '../src/protocol';
import { chooseComputerMove } from '../src/computer/engine';
import type { Color, GameCommand, GameState } from '../src/types';

function game(): GameState {
  const position = initialPosition();
  return { ...position, ruleset: ruleRegistry.selection(), ruleState: {}, revision: 1, initialPosition: structuredClone(position), roomId: 'INTRTEST', createdAt: 0,
    phase: 'playing', moves: [], drawOffer: null, joined: { w: true, b: true }, claimed: { w: true, b: true }, playStartedAt: 1000, lastMoveAt: null,
    crowns: { w: 'wQ', b: 'bQ' }, result: null, tokens: { w: 'w', b: 'b', observer: 'o' } };
}
function action(state: GameState, command: GameCommand, color: Color = state.turn, now = 5000) {
  const result = hiddenCrown.applyCommand(state, color, command, now);
  if ('error' in result) throw new Error(result.error);
  return result;
}
function relocate(state: GameState, id: string, square: number | null) {
  const p = state.pieces[id]; if (p.square !== null) state.board[p.square] = null;
  if (square !== null && state.board[square]) state.pieces[state.board[square]!].square = null;
  p.square = square; if (square !== null) state.board[square] = id;
}
describe('king interrogation', () => {
  it('creates v4 games with exactly seven crown candidates and retains legacy dispatch', () => {
    const state = game(); state.phase = 'crown_select'; state.crowns = { w: null, b: null };
    for (const color of ['w', 'b'] as const) {
      expect(Object.values(state.pieces).filter(p => p.color === color && crownCandidate(p))).toHaveLength(7);
      expect(hiddenCrown.applyCommand(state, color, { type: 'select_crown', pieceId: color + 'K' }, 0)).toEqual({ error: 'invalid_crown' });
      for (const p of Object.values(state.pieces).filter(p => p.color === color && crownCandidate(p))) expect('state' in hiddenCrown.applyCommand(state, color, { type: 'select_crown', pieceId: p.id }, 0)).toBe(true);
    }
    expect(ruleRegistry.selection().version).toBe(4);
    const legacy = ruleRegistry.resolve({ id: 'hidden-crown', version: 1 });
    expect('state' in legacy.applyCommand(state, 'w', { type: 'select_crown', pieceId: 'wQ' }, 0)).toBe(true);
    expect(legacy.applyCommand(game(), 'w', { type: 'interrogate', targetId: 'bQ' }, 0)).toEqual({ error: 'unsupported_action' });
    const previous = ruleRegistry.resolve({ id: 'hidden-crown', version: 2 });
    expect('state' in previous.applyCommand(state, 'w', { type: 'select_crown', pieceId: 'wK' }, 0)).toBe(true);
    expect(previous.applyCommand(state, 'w', { type: 'select_crown', pieceId: 'wQ' }, 0)).toEqual({ error: 'invalid_crown' });
    const oldGame = game(); oldGame.ruleset = ruleRegistry.selection({ id: 'hidden-crown', version: 2 }); relocate(oldGame, 'bK', 51);
    const oldAction = previous.applyCommand(oldGame, 'w', { type: 'interrogate', targetId: 'bK' }, 1000);
    expect('state' in oldAction && oldAction.state.moves[0].pieceId).toBe('wQ');
  });
  it('sees through blockers on files, ranks and diagonals, excluding other directions', () => {
    const state = game();
    // e1-f2-g3-h4 diagonal, e1-e7 file, e1-a1 rank; blockers remain.
    relocate(state, 'bNb', 31); relocate(state, 'bRa', 52); relocate(state, 'bBc', 0); relocate(state, 'bNg', 42);
    expect(interrogationTargets(state, 'w').sort()).toEqual(['bBc', 'bNb', 'bRa'].sort());
    for (const id of ['bPd', 'bK', 'wK', 'bNg', 'missing']) expect(hiddenCrown.applyCommand(state, 'w', { type: 'interrogate', targetId: id }, 0)).toEqual({ error: 'invalid_interrogation' });
    state.pieces.bRa.promoted = true; expect(interrogationTargets(state, 'w')).not.toContain('bRa');
  });
  it('requires a surviving original king; neither queen can substitute', () => {
    const state = game(); relocate(state, 'bRa', 52);
    relocate(state, 'wK', null); state.pieces.wPa.type = 'Q'; state.pieces.wPa.promoted = true;
    expect(interrogationTargets(state, 'w')).toEqual([]);
    relocate(state, 'wK', 4); state.pieces.wK.promoted = true;
    expect(interrogationTargets(state, 'w')).toEqual([]);
  });
  it('spends a turn without moving, expires en passant, records thinking time, and never wins by finding the crown', () => {
    const state = game(); relocate(state, 'bQ', 52); state.enPassant = 20; state.drawOffer = 'b';
    const result = action(state, { type: 'interrogate', targetId: 'bQ' });
    expect(result.state.board).toEqual(state.board); expect(result.state.pieces).toEqual(state.pieces);
    expect(result.state.turn).toBe('b'); expect(result.state.ply).toBe(1); expect(result.state.phase).toBe('playing'); expect(result.state.result).toBeNull();
    expect(result.state.enPassant).toBeNull(); expect(result.state.drawOffer).toBeNull(); expect(result.state.halfmoveClock).toBe(1);
    expect(result.state.moves[0]).toMatchObject({ kind: 'interrogation', targetId: 'bQ', targetSquare: 52, answer: 'crown', thinkMs: 4000, at: 5000 });
    expect(result.state.moves[0].notation).toBe('Ke1 ? bQ@e7');
    expect(result.state.pieces.wK.hasMoved).toBe(false);
    expect(result.events[0].type).toBe('interrogation');
    expect(hiddenCrown.applyCommand(result.state, 'w', { type: 'move', from: 12, to: 28 }, 5001)).toEqual({ error: 'not_your_turn' });
  });
  it('limits each side independently to two unique targets and does not consume quota on invalid attempts', () => {
    let state = game(); relocate(state, 'bRa', 52); relocate(state, 'bNb', 31); relocate(state, 'bBc', 0);
    state = action(state, { type: 'interrogate', targetId: 'bRa' }).state;
    state = action(state, { type: 'move', from: 48, to: 40 }).state;
    expect(interrogationTargets(state, 'w')).not.toContain('bRa');
    expect(hiddenCrown.applyCommand(state, 'w', { type: 'interrogate', targetId: 'bRa' }, 0)).toEqual({ error: 'invalid_interrogation' });
    state = action(state, { type: 'interrogate', targetId: 'bNb' }).state;
    state = action(state, { type: 'move', from: 40, to: 32 }).state;
    expect(interrogationTargets(state, 'w')).toEqual([]);
    expect(viewFor(state, 'w', { w: true, b: true }).interrogationsRemaining).toEqual({ w: 0, b: 2 });
  });
  it('redacts answers per action, including ended views; opposite answers produce identical opponent payloads and byte budgets', () => {
    const a = game(), b = game(); relocate(a, 'bQ', 52); relocate(b, 'bQ', 52); b.crowns.b = 'bRa';
    const yes = action(a, { type: 'interrogate', targetId: 'bQ' }), no = action(b, { type: 'interrogate', targetId: 'bQ' });
    const v = (s: GameState, role: 'w' | 'b' | 'observer') => viewFor(s, role, { w: true, b: true }, 6000);
    const { yourCrown: _a, ...publicYes } = v(yes.state, 'b'), { yourCrown: _b, ...publicNo } = v(no.state, 'b');
    expect(publicYes).toEqual(publicNo);
    expect(v(yes.state, 'b').moves[0]).not.toHaveProperty('answer');
    expect(v(yes.state, 'w').moves[0].answer).toBe('crown'); expect(v(no.state, 'w').moves[0].answer).toBe('clear');
    expect(v(yes.state, 'observer').moves[0].answer).toBe('crown');
    yes.state.phase = 'ended'; expect(v(yes.state, 'b').moves[0]).not.toHaveProperty('answer');
    expect(JSON.stringify(yes.events).length).toBe(JSON.stringify(no.events).length);
  });
  it('historical v3 prevents undo from crossing irreversible knowledge, but restores later moves around earlier interrogations', () => {
    const legacy = ruleRegistry.resolve({ id: 'hidden-crown', version: 3 });
    const legacyAction = (state: GameState, command: GameCommand, color: Color = state.turn) => { const result = legacy.applyCommand(state, color, command, 5000); if ('error' in result) throw new Error(result.error); return result; };
    let state = { ...game(), ruleset: ruleRegistry.selection({ id: 'hidden-crown', version: 3 }) }; relocate(state, 'wQ', 52);
    state = legacyAction(state, { type: 'move', from: 12, to: 28 }).state;
    state = legacyAction(state, { type: 'interrogate', targetId: 'wQ' }).state;
    expect(legacy.canRequestUndo!(state, 'w')).toBe(false); expect(legacy.canRequestUndo!(state, 'b')).toBe(false);
    state = { ...game(), ruleset: ruleRegistry.selection({ id: 'hidden-crown', version: 3 }) }; relocate(state, 'bRa', 52); state.initialPosition = structuredClone({ pieces: state.pieces, board: state.board, turn: state.turn });
    state = legacyAction(state, { type: 'interrogate', targetId: 'bRa' }).state;
    state = legacyAction(state, { type: 'move', from: 48, to: 40 }).state;
    const before = structuredClone(state);
    state = legacyAction(state, { type: 'move', from: 12, to: 28 }).state;
    state = legacyAction(state, { type: 'request_undo' }, 'w').state;
    state = legacyAction(state, { type: 'respond_undo', accept: true }, 'b').state;
    expect(state.board).toEqual(before.board); expect(state.pieces).toEqual(before.pieces); expect(state.moves).toEqual(before.moves);
    expect(state.halfmoveClock).toBe(before.halfmoveClock); expect(state.enPassant).toBe(before.enPassant);
    expect(viewFor(state, 'w', { w: true, b: true }).interrogationsRemaining?.w).toBe(1);
  });
  it('validates commands without allowing forged answers or combined moves', () => {
    expect(parseMessage('{"type":"interrogate","targetId":"bQ"}')).toEqual({ type: 'interrogate', targetId: 'bQ' });
    for (const extra of [{ answer: 'crown' }, { from: 0, to: 1 }, { targetId: 'bPa' }, { targetId: 42 }]) expect(parseMessage(JSON.stringify({ type: 'interrogate', targetId: 'bQ', ...extra }))).toBeNull();
    const state = game(); state.undoRequest = { color: 'b', targetPly: 0 };
    expect(hiddenCrown.applyCommand(state, 'w', { type: 'interrogate', targetId: 'bQ' }, 0)).toEqual({ error: 'undo_pending' });
    state.phase = 'ended'; expect(hiddenCrown.applyCommand(state, 'w', { type: 'interrogate', targetId: 'bQ' }, 0)).toEqual({ error: 'wrong_phase' });
  });
  it('continues after a king capture, disables that side’s interrogations, and still ends on a queen crown capture', () => {
    const state = game(); relocate(state, 'wK', 28); relocate(state, 'bQ', 36); state.turn = 'b';
    const next = action(state, { type: 'move', from: 36, to: 28 }).state;
    expect(next.pieces.wK.square).toBeNull(); expect(next.phase).toBe('playing'); expect(next.result).toBeNull();
    expect(hiddenCrown.legalMoves(next, 'w').length).toBeGreaterThan(0);
    expect(interrogationTargets(next, 'w')).toEqual([]);
    expect(action(next, { type: 'move', from: 12, to: 20 }).state.phase).toBe('playing');
    expect(hiddenCrown.applyCommand(next, 'w', { type: 'interrogate', targetId: 'bQ' }, 0)).toEqual({ error: 'invalid_interrogation' });
    const capture = game(); relocate(capture, 'bQ', 11);
    const won = action(capture, { type: 'move', from: 3, to: 11 }).state;
    expect(won.result).toEqual({ winner: 'w', reason: 'crown_captured' });
    expect(won.phase).toBe('ended');
  });
  it('lets the computer interrogate and use only its own acquired knowledge', () => {
    const state = game(); relocate(state, 'bRa', 52);
    const input = { color: 'w' as const, difficulty: 'hard' as const, ruleset: state.ruleset, pieces: state.pieces, board: state.board, turn: state.turn, enPassant: null, halfmoveClock: 0, ownCrown: 'wQ', interrogationTargets: ['bRa'], interrogationKnowledge: {} };
    expect(chooseComputerMove(input, () => 0).targetId).toBe('bRa');
    relocate(state, 'wQ', 44);
    expect(chooseComputerMove({ ...input, interrogationKnowledge: { bRa: 'crown' } }, () => 0).move?.to).toBe(52);
  });
});
