import { beforeAll, describe, expect, it, vi } from 'vitest';
import { recordsCsv, actionLabel, thinkingSeconds, visibleRecords } from '../public/js/game-records.js';
import { replayAt } from '../public/js/replay.js';
import { initialPosition } from '../src/engine';
import { crownCandidate } from '../src/rules/hidden-crown';

let canCrown, interrogationKnowledge, i18n;
beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  ({ canCrown, interrogationKnowledge } = await import('../public/js/board.js'));
  i18n = await import('../public/js/i18n.js');
});
describe('interrogations in exports and replay', () => {
  it('shows whole seconds to players and millisecond precision to administrators without reducing exported precision', () => {
    expect(thinkingSeconds(3599, 'w')).toBe('3');
    expect(thinkingSeconds(3599, 'b')).toBe('3');
    expect(thinkingSeconds(3599, 'observer')).toBe('3.599');
    expect(thinkingSeconds(-5, 'w')).toBe('0');
    expect(thinkingSeconds(undefined, 'observer')).toBe('0.000');
    expect(recordsCsv([{ thinkMs: 3599, at: 5000 }])).toContain('"3599"');
  });
  const record = { kind: 'interrogation', ply: 1, color: 'w', pieceId: 'wK', from: 4, to: 4, targetId: 'bBc', targetSquare: 58, answer: 'clear', notation: 'Ke1 ? bBc@c8', thinkMs: 4000, at: 5000 };
  it('merges only supplied private actions and rewinds knowledge with normal move progress', () => {
    const position = initialPosition(), move = { ply: 1, pieceId: 'wPe', from: 12, to: 28, color: 'w', at: 6000 };
    const next = { ...record, ply: 3, targetId: 'bRa', at: 8000 };
    const view = { ...position, initialPosition: position, role: 'w', moves: [move, { ply: 2, pieceId: 'bPe', from: 52, to: 36, color: 'b', at: 7000 }], interrogations: [record, next] };
    expect(visibleRecords(view)).toEqual([record, move, view.moves[1], next]);
    expect(interrogationKnowledge(view)).toEqual({ bBc: 'clear', bRa: 'clear' });
    expect(interrogationKnowledge(replayAt(view, 0))).toEqual({});
    expect(interrogationKnowledge(replayAt(view, 1))).toEqual({ bBc: 'clear' });
    expect(interrogationKnowledge(replayAt(view, 2))).toEqual({ bBc: 'clear', bRa: 'clear' });
    expect(replayAt(view, 1).turn).toBe('b');
    expect(visibleRecords({ ...view, interrogations: [] })).toEqual(view.moves);
  });
  it('explains private bonus interrogation consistently in both languages', () => {
    expect(i18n.t('private_rule6')).toContain('then make a normal move');
    expect(i18n.t('private_rule8')).toContain('opponent receives no notice');
    expect(i18n.t('private_interrogateHelp')).toContain('Your turn continues');
    i18n.toggleLanguage();
    expect(i18n.t('private_rule6')).toContain('审问不占走棋次数');
    expect(i18n.t('private_rule8')).toContain('对手不会收到提示');
    expect(i18n.t('private_interrogateHelp')).toContain('仍是你的回合');
    i18n.toggleLanguage();
  });
  it('exports the action, target, private answer and timestamp without inventing a capture', () => {
    const csv = recordsCsv([record]);
    expect(csv).toContain('action,target_id,target_square,interrogation_answer');
    expect(csv).toContain('"interrogation","bBc","58","clear"');
    expect(csv).toContain('1970-01-01T00:00:05.000Z');
    expect(csv).toContain('"Ke1 ? bBc@c8","wK"');
    const { answer, ...publicRecord } = record;
    expect(recordsCsv([publicRecord])).not.toContain('clear');
  });
  it('keeps client crown selection aligned with the server and preserves legacy selection', () => {
    const { pieces } = initialPosition();
    for (const piece of Object.values(pieces)) expect(canCrown(piece, 3)).toBe(crownCandidate(piece));
    expect(canCrown(pieces.wK, 3)).toBe(false); expect(canCrown(pieces.wQ, 3)).toBe(true);
    expect(canCrown(pieces.wK, 2)).toBe(true); expect(canCrown(pieces.wQ, 2)).toBe(false);
    expect(canCrown(pieces.wK, 1)).toBe(true); expect(canCrown(pieces.wQ, 1)).toBe(true);
  });
  it('renders synchronized English and Chinese rules, help and king history labels', () => {
    const pieces = initialPosition().pieces;
    if (i18n.language === 'zh') i18n.toggleLanguage();
    expect(i18n.t('rule1')).toContain('The king cannot be crowned');
    expect(i18n.t('rule7')).toContain('Only your king');
    expect(i18n.t('interrogateHelp')).toContain('your king');
    expect(actionLabel(record, i18n.t, pieces)).toBe('king: interrogate bishop at c8 · Not the crown');
    i18n.toggleLanguage();
    expect(i18n.t('rule1')).toContain('王不能成为王冠');
    expect(i18n.t('rule7')).toContain('王被吃掉后无法再审问');
    expect(i18n.t('interrogateHelp')).toContain('用王审问');
    expect(actionLabel(record, i18n.t, pieces)).toBe('王审问 c8 的象 · 不是王冠');
    expect(i18n.t('queen_rule1')).toContain('后不能成为王冠');
    i18n.toggleLanguage();
  });
  it('localizes the action and only renders supplied answers', () => {
    const translate = (key, values = {}) => ({ K: 'king', Q: 'queen', B: 'bishop', interrogation_clear: 'Not the crown', interrogation_private: 'Private answer', interrogationRecord: `${values.actor}: interrogate ${values.piece} at ${values.square}` })[key];
    expect(actionLabel(record, translate, { bBc: { type: 'B' } })).toBe('king: interrogate bishop at c8 · Not the crown');
    expect(actionLabel({ ...record, answer: undefined }, translate, { bBc: { type: 'B' } })).toContain('Private answer');
  });
  it('replays an interrogation without moving the king or changing castling rights', () => {
    const position = initialPosition();
    const view = { ...position, initialPosition: position, moves: [record, { ply: 2, pieceId: 'bPe', from: 52, to: 36, color: 'b' }], turn: 'w' };
    const after = replayAt(view, 1);
    expect(after.board).toEqual(position.board); expect(after.pieces).toEqual(position.pieces); expect(after.turn).toBe('b');
    expect(replayAt(view, 2).board[36]).toBe('bPe'); expect(replayAt(view, 2).board[4]).toBe('wK');
  });
  it('marks only the requesting player’s known answers, while observers see both sides', () => {
    const other = { ...record, color: 'b', targetId: 'wQ', answer: 'crown' };
    const hidden = { ...record, targetId: 'bRa', answer: undefined };
    expect(interrogationKnowledge({ role: 'w', moves: [record, other, hidden] })).toEqual({ bBc: 'clear' });
    expect(interrogationKnowledge({ role: 'b', moves: [record, other, hidden] })).toEqual({ wQ: 'crown' });
    expect(interrogationKnowledge({ role: 'observer', moves: [record, other, hidden] })).toEqual({ bBc: 'clear', wQ: 'crown' });
  });
  it('keeps marks attached to piece IDs after movement or capture and rewinds them with replay', () => {
    const position = initialPosition();
    const moves = [record, { ply: 2, pieceId: 'bBc', from: 58, to: 40, color: 'b' }, { ply: 3, pieceId: 'wQ', from: 3, to: 40, color: 'w', captured: 'bBc' }];
    const view = { ...position, initialPosition: position, role: 'w', moves };
    expect(interrogationKnowledge(replayAt(view, 0))).toEqual({});
    expect(interrogationKnowledge(replayAt(view, 1))).toEqual({ bBc: 'clear' });
    expect(replayAt(view, 2).pieces.bBc.square).toBe(40);
    expect(interrogationKnowledge(replayAt(view, 2))).toEqual({ bBc: 'clear' });
    expect(replayAt(view, 3).pieces.bBc.square).toBeNull();
    expect(interrogationKnowledge(replayAt(view, 3))).toEqual({ bBc: 'clear' });
  });
});
