import { advancePosition, initialPosition, opposite, pseudoLegalMoves } from '../engine';
import type { Color, GameCommand, GameState, LogEvent, Move, RuleSelection } from '../types';
import type { RuleSet } from './contract';

function normalizeOptions(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_ruleset');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['castling', 'enPassant', 'drawPlyLimit'].includes(key))) throw new Error('invalid_ruleset');
  const options = { castling: true, enPassant: true, drawPlyLimit: 100, ...value };
  if (typeof options.castling !== 'boolean' || typeof options.enPassant !== 'boolean' || !Number.isSafeInteger(options.drawPlyLimit) || Number(options.drawPlyLimit) < 10 || Number(options.drawPlyLimit) > 1000) throw new Error('invalid_ruleset');
  return options;
}
function legalMoves(state: GameState, color: Color) {
  const options = state.ruleset?.options ?? normalizeOptions({});
  return pseudoLegalMoves(state, color).filter(move => (options.castling || !move.castle) && (options.enPassant || !move.enPassant));
}
export const hiddenCrown: RuleSet = {
  id: 'hidden-crown', version: 1,
  name: { en: 'Hidden Crown', zh: '隐藏王冠' },
  normalizeOptions,
  initialize(_selection: RuleSelection) { return { ...initialPosition(), ruleState: {} }; },
  onPlayersJoined(state) { if (state.phase === 'lobby' && state.joined.w && state.joined.b) state.phase = 'crown_select'; },
  applyCommand,
  legalMoves,
  canRequestUndo(state, color) { return state.phase === 'playing' && !state.undoRequest && !state.drawOffer && state.moves.some(move => move.color === color); },
  applyMove(state: GameState, move: Move, now: number) {
    const applied = advancePosition(state, move, now);
    const next = applied.state, captured = applied.record.captured;
    if (captured && captured === next.crowns[opposite(applied.record.color)]) next.result = { winner: applied.record.color, reason: 'crown_captured' };
    else if (next.halfmoveClock >= Number(next.ruleset.options.drawPlyLimit)) next.result = { winner: null, reason: next.ruleset.options.drawPlyLimit === 100 ? '100_ply' : 'move_limit' };
    else if (!legalMoves(next, next.turn).length) next.result = { winner: null, reason: 'no_moves' };
    if (next.result) next.phase = 'ended';
    return applied;
  }
};

function applyCommand(state: GameState, color: Color, command: GameCommand, now: number) {
  let next = structuredClone(state);
  const events: LogEvent[] = [];
  const event = (type: LogEvent['type'], data?: Record<string, unknown>) => events.push({ t: now, actor: color, type, ...(data ? { data } : {}) });
  if (command.type === 'rule_action') return { error: 'unsupported_action' };
  if (command.type === 'select_crown') {
    if (state.phase !== 'crown_select') return { error: 'wrong_phase' };
    const piece = state.pieces[command.pieceId];
    if (state.crowns[color] || !piece || piece.color !== color || piece.type === 'P' || piece.promoted || piece.square === null) return { error: 'invalid_crown' };
    next.crowns[color] = piece.id; event('crown_locked', { pieceId: piece.id });
    if (next.crowns.w && next.crowns.b) {
      next.phase = 'playing'; next.playStartedAt = now; next.turnStartedAt = now;
      events.push({ t: now, actor: 'system', type: 'play_started' });
    }
  } else {
    if (state.phase !== 'playing') return { error: 'wrong_phase' };
    if (state.undoRequest && !['respond_undo', 'resign'].includes(command.type)) return { error: 'undo_pending' };
    switch (command.type) {
      case 'request_undo': {
        if (!hiddenCrown.canRequestUndo!(state, color)) return { error: 'undo_unavailable' };
        const last = [...state.moves].reverse().find(move => move.color === color)!;
        next.undoRequest = { color, targetPly: last.ply - 1 };
        event('undo_requested', { targetPly: next.undoRequest.targetPly }); break;
      }
      case 'respond_undo': {
        const request = state.undoRequest;
        if (!request || request.color === color) return { error: 'no_opponent_undo' };
        next.undoRequest = null;
        if (!command.accept) { event('undo_declined'); break; }
        const kept = state.moves.slice(0, request.targetPly), removed = state.moves.slice(request.targetPly);
        // Rebuild through the authoritative movement engine; this restores captures,
        // pawn promotion, castling rights, en-passant and the no-progress counter.
        let restored = { ...next, ...structuredClone(state.initialPosition), moves: [], ply: 0, halfmoveClock: 0, enPassant: null, lastMoveAt: null, result: null } as GameState;
        for (const record of kept) {
          const move = legalMoves(restored, restored.turn).find(move => move.pieceId === record.pieceId && move.from === record.from && move.to === record.to && move.promotion === record.promotion);
          if (!move) throw new Error('room_history_inconsistent');
          restored = advancePosition(restored, move, record.at).state;
        }
        next = { ...restored, moves: kept, undoRequest: null, drawOffer: null, turnStartedAt: now, phase: 'playing', result: null };
        event('undo_accepted', { targetPly: request.targetPly, removed }); break;
      }
      case 'move': {
        if (color !== state.turn) return { error: 'not_your_turn' };
        const move = legalMoves(state, color).find(move => move.from === command.from && move.to === command.to && move.promotion === command.promotion);
        if (!move) return { error: 'illegal_move' };
        const applied = hiddenCrown.applyMove(state, move, now); next = applied.state;
        event('move', { ...applied.record }); break;
      }
      case 'interrogate': return { error: 'unsupported_action' };
      case 'offer_draw':
        if (state.drawOffer) return { error: 'draw_already_open' };
        next.drawOffer = color; event('draw_offered'); break;
      case 'respond_draw':
        if (!state.drawOffer || state.drawOffer === color) return { error: 'no_opponent_offer' };
        next.drawOffer = null; event(command.accept ? 'draw_accepted' : 'draw_declined');
        if (command.accept) next.result = { winner: null, reason: 'agreement' }; break;
      case 'resign': next.result = { winner: opposite(color), reason: 'resign' }; event('resign'); break;
    }
  }
  if (next.result) { next.phase = 'ended'; next.drawOffer = null; next.undoRequest = null; events.push({ t: now, actor: 'system', type: 'game_ended', data: { ...next.result } }); }
  return { state: next, events };
}
