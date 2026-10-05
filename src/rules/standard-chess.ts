import { advancePosition, initialPosition, opposite, squareName } from '../engine';
import type { Color, GameCommand, GameState, LogEvent, Move } from '../types';
import type { RuleSet } from './contract';
import { hiddenCrown } from './hidden-crown';
import { chessFor, positionKey, publicMove } from './standard-position';

type Claim = { reason: 'threefold_repetition' | 'fifty_move'; move?: Move };
const counts = (state: GameState) => (state.ruleState.repetitions ?? {}) as Record<string, number>;
function currentClaim(state: GameState): Claim | undefined {
  if ((counts(state)[positionKey(chessFor(state))] ?? 0) >= 3) return { reason: 'threefold_repetition' };
  if (state.halfmoveClock >= 100) return { reason: 'fifty_move' };
}
function legalMoves(state: GameState, color: Color) {
  if (color !== state.turn) return [];
  return chessFor(state).moves({ verbose: true }).map(move => publicMove(move, state.pieces, state.board));
}
// Support a claim in the current position or by declaring a legal intended move.
export function drawClaim(state: GameState): Claim | undefined {
  if (state.phase !== 'playing') return;
  const current = currentClaim(state); if (current) return current;
  if (state.halfmoveClock < 99 && !Object.values(counts(state)).some(count => count >= 2)) return;
  const chess = chessFor(state);
  for (const move of chess.moves({ verbose: true })) {
    chess.move(move);
    const reason = (counts(state)[positionKey(chess)] ?? 0) >= 2 ? 'threefold_repetition' : Number(chess.fen().split(' ')[4]) >= 100 ? 'fifty_move' : undefined;
    chess.undo();
    if (reason) return { reason, move: publicMove(move, state.pieces, state.board) };
  }
}
function applyMove(state: GameState, move: Move, now: number) {
  const legal = legalMoves(state, state.turn).find(candidate => Object.keys(candidate).length === Object.keys(move).length && Object.entries(candidate).every(([key, value]) => (move as unknown as Record<string, unknown>)[key] === value));
  if (!legal) throw new Error('Illegal move');
  const chess = chessFor(state), before = chess.fen();
  const played = chess.move({ from: squareName(move.from), to: squareName(move.to), ...(move.promotion ? { promotion: move.promotion.toLowerCase() } : {}) });
  const applied = advancePosition(state, legal, now), next = applied.state;
  applied.record.notation = played.san;
  const irreversible = played.piece === 'p' || !!played.captured || before.split(' ')[2] !== chess.fen().split(' ')[2];
  const repetitions = irreversible ? {} : { ...counts(state) }, key = positionKey(chess);
  repetitions[key] = (repetitions[key] ?? 0) + 1; next.ruleState = { repetitions };
  if (chess.isCheckmate()) next.result = { winner: opposite(next.turn), reason: 'checkmate' };
  else if (chess.isStalemate()) next.result = { winner: null, reason: 'stalemate' };
  else if (chess.isInsufficientMaterial()) next.result = { winner: null, reason: 'insufficient_material' };
  else if (repetitions[key] >= 5) next.result = { winner: null, reason: 'fivefold_repetition' };
  else if (next.halfmoveClock >= 150) next.result = { winner: null, reason: 'seventy_five_move' };
  if (next.result) next.phase = 'ended';
  return applied;
}
function applyCommand(state: GameState, color: Color, command: GameCommand, now: number) {
  if (command.type === 'select_crown' || command.type === 'interrogate') return { error: 'unsupported_action' };
  if (command.type === 'rule_action') {
    if (command.action !== 'claim_draw') return { error: 'unsupported_action' };
    if (state.phase !== 'playing') return { error: 'wrong_phase' };
    if (state.turn !== color) return { error: 'not_your_turn' };
    const payload = command.payload;
    if (Object.keys(payload).some(key => !['from', 'to', 'promotion'].includes(key))) return { error: 'invalid_draw_claim' };
    let claim = currentClaim(state);
    if (Object.keys(payload).length) {
      const move = legalMoves(state, color).find(m => m.from === payload.from && m.to === payload.to && m.promotion === payload.promotion);
      if (!move) return { error: 'invalid_draw_claim' };
      const chess = chessFor(state); chess.move({ from: squareName(move.from), to: squareName(move.to), ...(move.promotion ? { promotion: move.promotion.toLowerCase() } : {}) });
      claim = (counts(state)[positionKey(chess)] ?? 0) >= 2 ? { reason: 'threefold_repetition', move } : Number(chess.fen().split(' ')[4]) >= 100 ? { reason: 'fifty_move', move } : undefined;
    }
    if (!claim) return { error: 'invalid_draw_claim' };
    const next = structuredClone(state); next.result = { winner: null, reason: claim.reason }; next.phase = 'ended'; next.drawOffer = null;
    return { state: next, events: [{ t: now, actor: color, type: 'rule_action', data: { action: 'claim_draw', ...claim } }, { t: now, actor: 'system', type: 'game_ended', data: next.result }] as LogEvent[] };
  }
  if (command.type !== 'move') return hiddenCrown.applyCommand(state, color, command, now);
  if (state.phase !== 'playing') return { error: 'wrong_phase' };
  if (state.turn !== color) return { error: 'not_your_turn' };
  const move = legalMoves(state, color).find(m => m.from === command.from && m.to === command.to && m.promotion === command.promotion);
  if (!move) return { error: 'illegal_move' };
  const applied = applyMove(state, move, now);
  const events: LogEvent[] = [{ t: now, actor: color, type: 'move', data: applied.record as unknown as Record<string, unknown> }];
  if (applied.state.result) events.push({ t: now, actor: 'system', type: 'game_ended', data: applied.state.result });
  return { state: applied.state, events };
}
export const standardChess: RuleSet = {
  id: 'standard-chess', version: 1, availableForNewRooms: true, supportsUndo: false,
  name: { en: 'Standard chess', zh: '标准国际象棋' },
  normalizeOptions(input) { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('invalid_ruleset'); return {}; },
  initialize() { const position = initialPosition(); return { ...position, ruleState: { repetitions: { [positionKey(chessFor(position))]: 1 } } }; },
  onPlayersJoined(state, now) { if (state.phase === 'lobby' && state.joined.w && state.joined.b) { state.phase = 'playing'; state.playStartedAt = now; state.turnStartedAt = now; } },
  legalMoves, applyMove, applyCommand,
  status(state) { return { inCheck: chessFor(state).isCheck(), ...(state.phase === 'playing' ? { drawClaim: drawClaim(state) } : {}) }; }
};
