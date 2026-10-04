import { describe, it, expect } from 'vitest';
import { boardTransitions } from '../public/js/board-motion.js';
const piece = (square, type = 'P', color = 'w') => ({ square, type, color });
const view = (pieces, count, role = 'w') => ({ pieces, moves: Array(count).fill({}), role });
describe('confirmed board transitions', () => {
  it('skips first load, reconnect gaps and unchanged move counts', () => {
    const a = view({ wPe: piece(12) }, 0), b = view({ wPe: piece(28) }, 1);
    expect(boardTransitions(null, b)).toEqual([]);
    expect(boardTransitions(a, view(b.pieces, 3))).toEqual([]);
    expect(boardTransitions(a, view(b.pieces, 0))).toEqual([]);
  });
  it('moves the king and rook together during castling', () => {
    const changes = boardTransitions(view({ wK: piece(4, 'K'), wRh: piece(7, 'R') }, 0), view({ wK: piece(6, 'K'), wRh: piece(5, 'R') }, 1));
    expect(changes.map(({ id, from, to }) => ({ id, from, to }))).toEqual([{ id: 'wK', from: 4, to: 6 }, { id: 'wRh', from: 7, to: 5 }]);
  });
  it('fades an en-passant victim on its actual square', () => {
    const changes = boardTransitions(view({ wPe: piece(36), bPd: piece(35, 'P', 'b') }, 7), view({ wPe: piece(43), bPd: piece(null, 'P', 'b') }, 8));
    expect(changes.find(m => m.id === 'bPd')).toMatchObject({ from: 35, to: null });
  });
  it('retains the pawn identity and both types for promotion', () => {
    const [change] = boardTransitions(view({ wPa: piece(48) }, 20), view({ wPa: piece(56, 'Q') }, 21));
    expect(change).toMatchObject({ id: 'wPa', from: 48, to: 56, previous: { type: 'P' }, next: { type: 'Q' } });
  });
  it('never animates already captured pieces or leaks crown fields', () => {
    const a = view({ wPa: piece(null), wPe: piece(12) }, 0); a.yourCrown = 'wK';
    const changes = boardTransitions(a, view({ wPa: piece(null), wPe: piece(28) }, 1));
    expect(changes).toHaveLength(1); expect(changes[0]).not.toHaveProperty('yourCrown');
  });
  it('uses the same permanent square coordinates for Black and skips role changes', () => {
    const a = view({ bPe: piece(52, 'P', 'b') }, 0, 'b'), b = view({ bPe: piece(36, 'P', 'b') }, 1, 'b');
    expect(boardTransitions(a, b)[0]).toMatchObject({ from: 52, to: 36 });
    expect(boardTransitions(a, { ...b, role: 'observer' })).toEqual([]);
  });
});
