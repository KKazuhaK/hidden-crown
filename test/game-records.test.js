import { describe, expect, it } from 'vitest';
import { recordsCsv, actionLabel } from '../public/js/game-records.js';
import { replayAt } from '../public/js/replay.js';
import { initialPosition } from '../src/engine';
describe('interrogations in exports and replay', () => {
  const record = { kind: 'interrogation', ply: 1, color: 'w', pieceId: 'wQ', from: 3, to: 3, targetId: 'bBc', targetSquare: 58, answer: 'clear', notation: 'Qd1 ? bBc@c8', thinkMs: 4000, at: 5000 };
  it('exports the action, target, private answer and timestamp without inventing a capture', () => {
    const csv = recordsCsv([record]);
    expect(csv).toContain('action,target_id,target_square,interrogation_answer');
    expect(csv).toContain('"interrogation","bBc","58","clear"');
    expect(csv).toContain('1970-01-01T00:00:05.000Z');
    const { answer, ...publicRecord } = record;
    expect(recordsCsv([publicRecord])).not.toContain('clear');
  });
  it('localizes the action and only renders supplied answers', () => {
    const translate = (key, values = {}) => ({ B: 'bishop', interrogation_clear: 'Not the crown', interrogation_private: 'Private answer', interrogationRecord: `Interrogate ${values.piece} at ${values.square}` })[key];
    expect(actionLabel(record, translate, { bBc: { type: 'B' } })).toBe('Interrogate bishop at c8 · Not the crown');
    expect(actionLabel({ ...record, answer: undefined }, translate, { bBc: { type: 'B' } })).toContain('Private answer');
  });
  it('replays an interrogation without moving the queen or changing castling rights', () => {
    const position = initialPosition();
    const view = { ...position, initialPosition: position, moves: [record, { ply: 2, pieceId: 'bPe', from: 52, to: 36, color: 'b' }], turn: 'w' };
    const after = replayAt(view, 1);
    expect(after.board).toEqual(position.board); expect(after.pieces).toEqual(position.pieces); expect(after.turn).toBe('b');
    expect(replayAt(view, 2).board[36]).toBe('bPe'); expect(replayAt(view, 2).board[3]).toBe('wQ');
  });
});
