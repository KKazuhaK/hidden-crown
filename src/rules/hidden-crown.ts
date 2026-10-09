import { hiddenCrown as previousRules } from './hidden-crown-v4';
import { advancePosition, opposite, squareName } from '../engine';
import type { GameState, MoveRecord } from '../types';
import type { RuleSet } from './contract';
import { crownCandidate } from './hidden-crown-v3';
export { crownCandidate } from './hidden-crown-v3';

// Bonus actions stay separate from public plies and never change movement rights.
export const interrogationRecords = (state: GameState) => (state.ruleState.interrogations ?? []) as MoveRecord[];
export function interrogationTargets(state: GameState, color: 'w' | 'b') {
  const king = state.pieces[color + 'K'], previous = interrogationRecords(state).filter(record => record.color === color);
  if (!king || king.promoted || king.type !== 'K' || king.square === null || state.board[king.square] !== king.id || previous.length >= 2) return [];
  return Object.values(state.pieces).filter(piece => {
    if (piece.color === color || !crownCandidate(piece) || state.board[piece.square!] !== piece.id || previous.some(record => record.targetId === piece.id)) return false;
    const df = Math.abs(piece.square! % 8 - king.square! % 8), dr = Math.abs(Math.floor(piece.square! / 8) - Math.floor(king.square! / 8));
    return df === 0 || dr === 0 || df === dr;
  }).map(piece => piece.id);
}
export const hiddenCrown: RuleSet = {
  ...previousRules,
  version: 5,
  availableForNewRooms: true,
  privateInterrogations: true,
  interrogationRecords,
  interrogationTargets,
  applyMove(state, move, now) {
    const applied = advancePosition(state, move, now), next = applied.state;
    if (applied.record.captured === next.crowns[opposite(applied.record.color)]) next.result = { winner: applied.record.color, reason: 'crown_captured' };
    else if (next.halfmoveClock >= Number(next.ruleset.options.drawPlyLimit)) next.result = { winner: null, reason: next.ruleset.options.drawPlyLimit === 100 ? '100_ply' : 'move_limit' };
    // A private interrogation cannot replace a move when there are no legal moves.
    else if (!hiddenCrown.legalMoves(next, next.turn).length) next.result = { winner: null, reason: 'no_moves' };
    if (next.result) next.phase = 'ended';
    return applied;
  },
  applyCommand(state, color, command, now) {
    if (command.type === 'interrogate' || command.type === 'move') {
      if (state.phase !== 'playing') return { error: 'wrong_phase' };
      if (state.undoRequest) return { error: 'undo_pending' };
      if (color !== state.turn) return { error: 'not_your_turn' };
      if (command.type === 'move') {
        const move = hiddenCrown.legalMoves(state, color).find(move => move.from === command.from && move.to === command.to && move.promotion === command.promotion);
        if (!move) return { error: 'illegal_move' };
        const applied = hiddenCrown.applyMove(state, move, now), next = applied.state;
        const events = [{ t: now, actor: color, type: 'move' as const, data: { ...applied.record } }];
        if (next.result) {
          next.drawOffer = null; next.undoRequest = null;
          return { state: next, events: [...events, { t: now, actor: 'system' as const, type: 'game_ended' as const, data: { ...next.result } }] };
        }
        return { state: next, events };
      }
      if (!interrogationTargets(state, color).includes(command.targetId)) return { error: 'invalid_interrogation' };
      const king = state.pieces[color + 'K'], target = state.pieces[command.targetId];
      const record: MoveRecord = { kind: 'interrogation', pieceId: king.id, from: king.square!, to: king.square!, targetId: target.id, targetSquare: target.square!,
        answer: state.crowns[opposite(color)] === target.id ? 'crown' : 'clear', ply: state.ply + 1, color,
        notation: `K${squareName(king.square!)} ? ${target.id}@${squareName(target.square!)}`, at: now,
        thinkMs: Math.max(0, now - (state.turnStartedAt ?? state.lastMoveAt ?? state.playStartedAt ?? now)) };
      const next = structuredClone(state);
      next.ruleState.interrogations = [...interrogationRecords(next), record];
      return { state: next, events: [{ t: now, actor: color, type: 'interrogation', data: { ...record } }] };
    }
    return previousRules.applyCommand(state, color, command, now);
  }
};
