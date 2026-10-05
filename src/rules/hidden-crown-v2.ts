import { advancePosition, initialPosition, opposite, pseudoLegalMoves, squareName } from '../engine';
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
export function crownCandidate(piece: GameState['pieces'][string]) {
  return /^[wb](K|R[ah]|B[cf]|N[bg])$/.test(piece.id) && !piece.promoted && piece.type !== 'P' && piece.type !== 'Q' && piece.square !== null;
}
export function interrogationTargets(state: GameState, color: Color) {
  const queen = state.pieces[color + 'Q'];
  const previous = state.moves.filter(m => m.kind === 'interrogation' && m.color === color);
  if (!queen || queen.promoted || queen.type !== 'Q' || queen.square === null || state.board[queen.square] !== queen.id || previous.length >= 2) return [];
  return Object.values(state.pieces).filter(piece => {
    if (piece.color === color || !crownCandidate(piece) || state.board[piece.square!] !== piece.id || previous.some(m => m.targetId === piece.id)) return false;
    const df = Math.abs(piece.square! % 8 - queen.square! % 8), dr = Math.abs(Math.floor(piece.square! / 8) - Math.floor(queen.square! / 8));
    return df === 0 || dr === 0 || df === dr;
  }).map(piece => piece.id);
}
function finishTurn(next: GameState, captured?: string, mover?: Color) {
  if (captured && captured === next.crowns[opposite(mover!)]) next.result = { winner: mover!, reason: 'crown_captured' };
  else if (next.halfmoveClock >= Number(next.ruleset.options.drawPlyLimit)) next.result = { winner: null, reason: next.ruleset.options.drawPlyLimit === 100 ? '100_ply' : 'move_limit' };
  else if (!legalMoves(next, next.turn).length && !interrogationTargets(next, next.turn).length) next.result = { winner: null, reason: 'no_moves' };
  if (next.result) next.phase = 'ended';
}
export const hiddenCrown: RuleSet = {
  id: 'hidden-crown', version: 2,
  availableForNewRooms: false, supportsUndo: true,
  name: { en: 'Hidden Crown', zh: '隐藏王冠' },
  normalizeOptions,
  initialize(_selection: RuleSelection) { return { ...initialPosition(), ruleState: {} }; },
  onPlayersJoined(state) { if (state.phase === 'lobby' && state.joined.w && state.joined.b) state.phase = 'crown_select'; },
  applyCommand,
  legalMoves,
  interrogationTargets,
  canRequestUndo(state, color) {
    const last = [...state.moves].reverse().find(m => m.color === color);
    return state.phase === 'playing' && !state.undoRequest && !state.drawOffer && !!last && last.kind !== 'interrogation' && !state.moves.slice(last.ply - 1).some(m => m.kind === 'interrogation');
  },
  applyMove(state: GameState, move: Move, now: number) {
    const applied = advancePosition(state, move, now);
    const next = applied.state, captured = applied.record.captured;
    finishTurn(next, captured, applied.record.color);
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
    if (state.crowns[color] || !piece || piece.color !== color || !crownCandidate(piece)) return { error: 'invalid_crown' };
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
          if (record.kind === 'interrogation') {
            restored.moves.push(record); restored.ply++; restored.turn = opposite(restored.turn);
            restored.enPassant = null; restored.halfmoveClock++; restored.lastMoveAt = record.at; restored.turnStartedAt = record.at;
            continue;
          }
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
      case 'interrogate': {
        if (color !== state.turn) return { error: 'not_your_turn' };
        if (!interrogationTargets(state, color).includes(command.targetId)) return { error: 'invalid_interrogation' };
        const queen = state.pieces[color + 'Q'], target = state.pieces[command.targetId];
        const record = { kind: 'interrogation' as const, pieceId: queen.id, from: queen.square!, to: queen.square!, targetId: target.id, targetSquare: target.square!,
          answer: state.crowns[opposite(color)] === target.id ? 'crown' as const : 'clear' as const,
          ply: state.ply + 1, color, notation: `Q${squareName(queen.square!)} ? ${target.id}@${squareName(target.square!)}`, at: now,
          thinkMs: Math.max(0, now - (state.turnStartedAt ?? state.lastMoveAt ?? state.playStartedAt ?? now)) };
        next.moves.push(record); next.ply++; next.turn = opposite(color); next.enPassant = null; next.halfmoveClock++;
        next.lastMoveAt = now; next.turnStartedAt = now; next.drawOffer = null;
        event('interrogation', { ...record }); finishTurn(next); break;
      }
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
