import { describe, it, expect } from 'vitest';
import { initialPosition, applyMove, pseudoLegalMoves } from '../src/engine';
import { replayAt, canReplay, centeredScrollTop } from '../public/js/replay.js';

function game(sequence) {
  let state = { ...initialPosition(), phase: 'playing', result: null, moves: [], crowns: { w: 'wK', b: 'bK' }, lastMoveAt: null, playStartedAt: 0 };
  const positions = [structuredClone(state)];
  for (const [from, to] of sequence) {
    const square = name => 'abcdefgh'.indexOf(name[0]) + (Number(name[1]) - 1) * 8;
    const move = pseudoLegalMoves(state, state.turn).find(move => move.from === square(from) && move.to === square(to));
    expect(move).toBeDefined(); state = applyMove(state, move, 1000).state; positions.push(structuredClone(state));
  }
  return { view: { pieces: state.pieces, board: state.board, moves: state.moves, role: 'w', yourCrown: 'wK', phase: 'playing', legalMoves: [] }, positions };
}
describe('public move replay', () => {
  it('opens player replay only after the game; administrator observation can replay during play', () => {
    expect(canReplay({ phase: 'playing', role: 'w' })).toBe(false);
    expect(canReplay({ phase: 'crown_select', role: 'b' })).toBe(false);
    expect(canReplay({ phase: 'ended', role: 'w' })).toBe(true);
    expect(canReplay({ phase: 'playing', role: 'observer' })).toBe(true);
  });
  it('centers the selected row and clamps the first and last rows to list boundaries', () => {
    expect(centeredScrollTop(600, 40, 300, 1200)).toBe(470);
    expect(centeredScrollTop(0, 40, 300, 1200)).toBe(0);
    expect(centeredScrollTop(1160, 40, 300, 1200)).toBe(900);
    expect(centeredScrollTop(40, 40, 300, 120)).toBe(0);
  });
  it('reconstructs every position, including a normal capture, without mutating the live view', () => {
    const { view, positions } = game([['e2','e4'], ['d7','d5'], ['e4','d5'], ['g8','f6']]);
    const saved = structuredClone(view);
    for (let ply = 0; ply <= view.moves.length; ply++) {
      const replay = replayAt(view, ply); expect(replay.board).toEqual(positions[ply].board); expect(replay.pieces).toEqual(positions[ply].pieces);
      expect(replay).not.toHaveProperty('crowns'); expect(replay.yourCrown).toBe('wK'); expect(replay.legalMoves).toEqual([]);
    }
    expect(view).toEqual(saved);
  });
  it('rewinds both kings and rooks across castling for either color', () => {
    const { view, positions } = game([['g1','f3'], ['g8','f6'], ['g2','g3'], ['g7','g6'], ['f1','g2'], ['f8','g7'], ['e1','g1'], ['e8','g8']]);
    for (const ply of [0, 6, 7, 8]) expect(replayAt(view, ply).pieces).toEqual(positions[ply].pieces);
  });
  it('restores the captured pawn when rewinding en passant', () => {
    const { view, positions } = game([['e2','e4'], ['a7','a6'], ['e4','e5'], ['d7','d5'], ['e5','d6']]);
    expect(replayAt(view, 4).pieces.bPd.square).toBe(35);
    expect(replayAt(view, 5).board).toEqual(positions[5].board);
    expect(replayAt(view, 5).pieces.bPd.square).toBeNull();
  });
  it('restores the original pawn type before promotion and preserves its ID afterward', () => {
    const view = { ...initialPosition(), moves: [{ pieceId:'wPa', from:8, to:56, color:'w', captured:'bRa', promotion:'N', ply:1 }], role:'observer', crowns:{w:'wK', b:'bQ'} };
    view.pieces.wPa.type = 'N'; view.pieces.wPa.promoted = true; view.pieces.wPa.square = 56;
    expect(replayAt(view, 0).pieces.wPa).toMatchObject({ type:'P', promoted:false, square:8 });
    expect(replayAt(view, 1).pieces.wPa).toMatchObject({ id:'wPa', type:'N', promoted:true, square:56 });
    expect(replayAt(view, 1).crowns).toEqual(view.crowns);
    expect(replayAt(view, 99).moves).toHaveLength(1); expect(replayAt(view, -1).moves).toHaveLength(0);
  });
});
