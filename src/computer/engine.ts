import { opposite, pseudoLegalMoves } from '../engine';
import type { Color, Difficulty, GameState, Move, Piece, RuleSelection } from '../types';

// Only information a player may know crosses the computation boundary. No enemy crown,
// tokens, private rule state or crown-selection log is accepted by the search engine.
export interface ComputerInput {
  color: Color; difficulty: Difficulty; ruleset: RuleSelection;
  pieces: Record<string, Piece>; board: (string | null)[]; turn: Color;
  enPassant: number | null; halfmoveClock: number; ownCrown: string | null;
  interrogationTargets?: string[];
  interrogationKnowledge?: Record<string, 'crown' | 'clear'>;
}
export type Position = Pick<ComputerInput, 'pieces' | 'board' | 'turn' | 'enPassant' | 'halfmoveClock'>;
export const searchLimits = {
  easy: { depth: 1, nodes: 64, milliseconds: 15 },
  medium: { depth: 2, nodes: 1600, milliseconds: 65 },
  hard: { depth: 4, nodes: 8000, milliseconds: 160 }
} as const;
const values = { P: 100, N: 320, B: 335, R: 500, Q: 900, K: 360 };
export const isCrownCandidate = (p: Piece, version = 3) => /^[wb](K|Q|R[ah]|B[cf]|N[bg])$/.test(p.id) && (version === 1 || p.id[1] !== (version === 2 ? 'Q' : 'K')) && !p.promoted && p.square !== null;
function movesFor(p: Position, color: Color, options: RuleSelection['options']) {
  return pseudoLegalMoves(p as GameState, color).filter(m => (options.castling || !m.castle) && (options.enPassant || !m.enPassant));
}
// Search positions share unchanged immutable pieces and contain no history. Live moves
// are always revalidated/applied by RuleSet; parity tests cover these special moves.
export function advanceSearch(p: Position, m: Move): Position {
  const pieces = { ...p.pieces }, board = [...p.board], old = pieces[m.pieceId];
  const capture = m.enPassant ? m.to + (old.color === 'w' ? -8 : 8) : m.to;
  const victim = board[capture]; if (victim) pieces[victim] = { ...pieces[victim], square: null };
  board[capture] = null; board[m.from] = null; board[m.to] = old.id;
  pieces[old.id] = { ...old, square: m.to, hasMoved: true, ...(m.promotion ? { type: m.promotion, promoted: true } : {}) };
  if (m.castle) {
    const rook = pieces[old.color + (m.castle === 'K' ? 'Rh' : 'Ra')];
    const to = (old.color === 'w' ? 0 : 56) + (m.castle === 'K' ? 5 : 3);
    board[rook.square!] = null; board[to] = rook.id; pieces[rook.id] = { ...rook, square: to, hasMoved: true };
  }
  return { pieces, board, turn: opposite(p.turn),
    enPassant: old.type === 'P' && Math.abs(m.to - m.from) === 16 ? (m.to + m.from) / 2 : null,
    halfmoveClock: victim || old.type === 'P' ? 0 : p.halfmoveClock + 1 };
}
function ordering(p: Position, m: Move) {
  const id = p.board[m.to]; return (id ? values[p.pieces[id].type] * 10 : m.enPassant ? 1000 : 0) + (m.promotion ? values[m.promotion] : 0) + (m.castle ? 30 : 0);
}
export function chooseComputerMove(input: ComputerInput, random = Math.random): { move: Move | null; targetId?: string; nodes: number; completedDepth: number } {
  const limits = searchLimits[input.difficulty], started = performance.now();
  let nodes = 0, completedDepth = 0, aborted = false;
  const legal = movesFor(input, input.color, input.ruleset.options);
  if (input.turn !== input.color || !input.ownCrown) return { move: null, nodes, completedDepth };
  const knownCrown = Object.entries(input.interrogationKnowledge ?? {}).find(([, answer]) => answer === 'crown')?.[0];
  const winningCapture = legal.find(move => input.board[move.to] === knownCrown && !!knownCrown);
  if (winningCapture) return { move: winningCapture, nodes: 1, completedDepth: 1 };
  const targets = input.interrogationTargets ?? [];
  const candidateCapture = legal.some(move => { const piece = input.pieces[input.board[move.to]!]; return piece && isCrownCandidate(piece, input.ruleset.version) && input.interrogationKnowledge?.[piece.id] !== 'clear'; });
  if (targets.length && (!legal.length || (!knownCrown && !candidateCapture && random() < ({ easy: .2, medium: .45, hard: .7 }[input.difficulty])))) {
    return { move: null, targetId: targets[Math.min(targets.length - 1, Math.floor(random() * targets.length))], nodes: 1, completedDepth: 1 };
  }
  if (!legal.length) return { move: null, nodes, completedDepth };
  if (input.difficulty === 'easy') {
    // Usually play any legal move; sometimes prefer a capture. No hidden information.
    const captures = legal.filter(m => input.board[m.to] || m.enPassant);
    const pool = captures.length && random() < .35 ? captures : legal;
    return { move: pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))], nodes: 1, completedDepth: 1 };
  }
  const candidate = (piece: Piece) => isCrownCandidate(piece, input.ruleset.version) && input.interrogationKnowledge?.[piece.id] !== 'clear';
  const enemy = opposite(input.color), originalCandidates = Object.values(input.pieces).filter(p => p.color === enemy && candidate(p)).length || 1;
  function evaluate(p: Position) {
    if (knownCrown && p.pieces[knownCrown]?.square === null) return 100000;
    if (p.pieces[input.ownCrown!]?.square === null) return -100000;
    let score = 0, candidates = 0;
    for (const piece of Object.values(p.pieces)) if (piece.square !== null) {
      const centrality = 7 - Math.abs(piece.square % 8 - 3.5) - Math.abs(Math.floor(piece.square / 8) - 3.5);
      const advancement = piece.type === 'P' ? (piece.color === 'w' ? Math.floor(piece.square / 8) : 7 - Math.floor(piece.square / 8)) * 8 : 0;
      score += (piece.color === input.color ? 1 : -1) * (values[piece.type] + centrality * 5 + advancement);
      if (piece.color === enemy && candidate(piece)) candidates++;
    }
    // Every surviving original enemy non-pawn remains a possible crown. Uniform
    // belief is derived from public captures, never from the actual selection.
    score += (originalCandidates - candidates) * 6000 / originalCandidates;
    const crownSquare = p.pieces[input.ownCrown!]?.square;
    const threatened = movesFor(p, enemy, input.ruleset.options).some(m => m.to === crownSquare);
    if (threatened) score -= p.turn === enemy ? 18000 : 2200;
    return score;
  }
  function search(p: Position, depth: number, alpha: number, beta: number): number {
    nodes++;
    if (nodes >= limits.nodes || performance.now() - started >= limits.milliseconds) { aborted = true; return evaluate(p); }
    if (!depth || p.pieces[input.ownCrown!]?.square === null) return evaluate(p);
    if (p.halfmoveClock >= Number(input.ruleset.options.drawPlyLimit)) return 0;
    const moves = movesFor(p, p.turn, input.ruleset.options).sort((a, b) => ordering(p, b) - ordering(p, a));
    if (!moves.length) return 0;
    const maximize = p.turn === input.color; let best = maximize ? -Infinity : Infinity;
    for (const m of moves) {
      const value = search(advanceSearch(p, m), depth - 1, alpha, beta);
      best = maximize ? Math.max(best, value) : Math.min(best, value);
      if (maximize) alpha = Math.max(alpha, best); else beta = Math.min(beta, best);
      if (beta <= alpha || aborted) break;
    }
    return best;
  }
  const ordered = legal.sort((a, b) => ordering(input, b) - ordering(input, a));
  let chosen = ordered[0];
  for (let depth = 1; depth <= limits.depth; depth++) {
    let best = -Infinity, candidate = chosen;
    // Previous best first improves pruning and returns a complete earlier iteration.
    const first = ordered.indexOf(chosen); if (first > 0) ordered.unshift(...ordered.splice(first, 1));
    for (const m of ordered) {
      const score = search(advanceSearch(input, m), depth - 1, best, Infinity);
      if (aborted) break;
      if (score > best) { best = score; candidate = m; }
    }
    if (aborted) break;
    chosen = candidate; completedDepth = depth;
  }
  return { move: chosen, nodes, completedDepth };
}
