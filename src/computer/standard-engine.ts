import type { Chess, Move as ChessMove } from 'chess.js';
import { chessFor, publicMove, squareIndex } from '../rules/standard-position';
import { searchLimits, type ComputerInput } from './engine';
const values: Record<string, number> = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 0 };
const ordering = (move: ChessMove) => (move.captured ? values[move.captured] * 10 - values[move.piece] : 0) + (move.promotion ? values[move.promotion] : 0) + (move.san.includes('#') ? 100000 : move.san.includes('+') ? 30 : 0);
export function chooseStandardMove(input: ComputerInput, random: () => number) {
  const limits = searchLimits[input.difficulty], started = performance.now(), chess = chessFor(input);
  let nodes = 0, completedDepth = 0, aborted = false;
  if (input.turn !== input.color) return { move: null, nodes, completedDepth };
  if (input.drawClaim) return { move: null, claimDraw: input.drawClaim, nodes, completedDepth };
  const moves = chess.moves({ verbose: true }).sort((a, b) => ordering(b) - ordering(a));
  if (!moves.length) return { move: null, nodes, completedDepth };
  if (input.difficulty === 'easy') {
    const chosen = moves[Math.min(moves.length - 1, Math.floor(random() * moves.length))];
    return { move: publicMove(chosen, input.pieces, input.board), nodes: 1, completedDepth: 1 };
  }
  function evaluate(position: Chess) {
    let score = 0;
    for (const row of position.board()) for (const piece of row) if (piece) {
      const square = squareIndex(piece.square), central = 7 - Math.abs(square % 8 - 3.5) - Math.abs(Math.floor(square / 8) - 3.5);
      const advancement = piece.type === 'p' ? (piece.color === 'w' ? Math.floor(square / 8) : 7 - Math.floor(square / 8)) * 8 : 0;
      score += (piece.color === input.color ? 1 : -1) * (values[piece.type] + central * (piece.type === 'k' ? -3 : 5) + advancement);
    }
    return score;
  }
  function search(depth: number, alpha: number, beta: number, distance: number): number {
    nodes++;
    if (nodes >= limits.nodes || performance.now() - started >= limits.milliseconds) { aborted = true; return evaluate(chess); }
    if (!depth) {
      if (chess.isCheckmate()) return chess.turn() === input.color ? -100000 + distance : 100000 - distance;
      if (chess.isStalemate() || chess.isInsufficientMaterial() || chess.isDrawByFiftyMoves() || chess.isThreefoldRepetition()) return 0;
      return evaluate(chess);
    }
    const legal = chess.moves({ verbose: true });
    if (!legal.length) return chess.isCheck() ? (chess.turn() === input.color ? -100000 + distance : 100000 - distance) : 0;
    if (chess.isInsufficientMaterial() || chess.isDrawByFiftyMoves() || chess.isThreefoldRepetition()) return 0;
    const maximize = chess.turn() === input.color; let best = maximize ? -Infinity : Infinity;
    for (const move of legal.sort((a, b) => ordering(b) - ordering(a))) {
      chess.move(move); const value = search(depth - 1, alpha, beta, distance + 1); chess.undo();
      best = maximize ? Math.max(best, value) : Math.min(best, value);
      if (maximize) alpha = Math.max(alpha, best); else beta = Math.min(beta, best);
      if (alpha >= beta || aborted) break;
    }
    return best;
  }
  let chosen = moves[0];
  for (let depth = 1; depth <= limits.depth; depth++) {
    let best = -Infinity, candidate = chosen;
    const first = moves.indexOf(chosen); if (first > 0) moves.unshift(...moves.splice(first, 1));
    for (const move of moves) {
      chess.move(move); const score = search(depth - 1, best, Infinity, 1); chess.undo();
      if (aborted) break;
      if (score > best) { best = score; candidate = move; }
    }
    if (aborted) break;
    chosen = candidate; completedDepth = depth;
  }
  return { move: publicMove(chosen, input.pieces, input.board), nodes, completedDepth };
}
