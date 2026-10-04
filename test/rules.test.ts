import { describe, expect, it } from 'vitest';
import { ruleRegistry, RuleRegistry } from '../src/rules/registry';
import { hiddenCrown } from '../src/rules/hidden-crown-v1';
import { viewFor } from '../src/protocol';
import type { GameState } from '../src/types';

function state(options = {}) {
  const selection = ruleRegistry.selection({ id: 'hidden-crown', version: 1, options });
  const position = hiddenCrown.initialize(selection);
  return { ...position, ruleset: selection, revision: 0, initialPosition: structuredClone(position), roomId: 'TESTROOM', createdAt: 0,
    phase: 'playing', moves: [], drawOffer: null, joined: { w: true, b: true }, claimed: { w: true, b: true },
    playStartedAt: 0, lastMoveAt: null, result: null, crowns: { w: 'wK', b: 'bK' },
    tokens: { w: 'white', b: 'black', observer: 'admin' } } as GameState;
}
describe('versioned rule dispatch', () => {
  it('rejects unknown versions, arbitrary options and duplicate registration', () => {
    expect(() => ruleRegistry.selection({ id: 'hidden-crown', version: 999 })).toThrow('unsupported_ruleset');
    expect(() => ruleRegistry.selection({ id: 'hidden-crown', version: 1, options: { script: 'anything' } })).toThrow('invalid_ruleset');
    expect(() => ruleRegistry.selection({ id: 'hidden-crown', version: 1, options: { drawPlyLimit: 0 } })).toThrow('invalid_ruleset');
    expect(() => new RuleRegistry([hiddenCrown, hiddenCrown])).toThrow('duplicate_ruleset');
  });
  it('keeps rule-private state out of player and administrator views', () => {
    const game = state(); game.ruleState = { privateSecret: 'never-export' };
    for (const role of ['w', 'b', 'observer'] as const) expect(JSON.stringify(viewFor(game, role, { w: true, b: true }))).not.toContain('never-export');
    expect(viewFor(game, 'w', { w: true, b: true }).crowns).toBeUndefined();
  });
  it('dispatches another registered version without modifying the room or storage interface', () => {
    const registry = new RuleRegistry([hiddenCrown, { ...hiddenCrown, version: 2 }]);
    const selection = registry.selection({ id: 'hidden-crown', version: 2, options: { drawPlyLimit: 20 } });
    expect(registry.resolve(selection).version).toBe(2); expect(selection.options.drawPlyLimit).toBe(20);
    expect(ruleRegistry.resolve(state().ruleset).version).toBe(1);
  });
  it('uses selected draw limits rather than the original engine default', () => {
    const game = state({ drawPlyLimit: 10 }); game.halfmoveClock = 9;
    const move = hiddenCrown.legalMoves(game, 'w').find(move => move.from === 6 && move.to === 21)!;
    expect(hiddenCrown.applyMove(game, move, 1000).state.result?.reason).toBe('move_limit');
    expect(hiddenCrown.applyMove(state(), move, 1000).state.result).toBeNull();
  });
  it('disables castling for that room without changing other rooms', () => {
    const game = state({ castling: false });
    for (const square of [5, 6]) { game.pieces[game.board[square]!].square = null; game.board[square] = null; }
    expect(hiddenCrown.legalMoves(game, 'w').some(move => move.castle)).toBe(false);
    game.ruleset = ruleRegistry.selection();
    expect(hiddenCrown.legalMoves(game, 'w').some(move => move.castle)).toBe(true);
  });
});
