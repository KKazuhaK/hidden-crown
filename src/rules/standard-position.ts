import { Chess, type Move as ChessMove } from 'chess.js';
import { squareName } from '../engine';
import type { Color, GameState, Move, Piece, Promotion } from '../types';

export type ChessPosition = Pick<GameState, 'pieces' | 'board' | 'turn' | 'enPassant' | 'halfmoveClock'> & { ply?: number };
export const squareIndex = (name: string) => (Number(name[1]) - 1) * 8 + name.charCodeAt(0) - 97;
export function positionFen(position: ChessPosition): string {
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = '', empty = 0;
    for (let file = 0; file < 8; file++) {
      const id = position.board[rank * 8 + file], piece = id ? position.pieces[id] : undefined;
      if (!piece) empty++;
      else { if (empty) row += empty; empty = 0; row += piece.color === 'w' ? piece.type : piece.type.toLowerCase(); }
    }
    if (empty) row += empty; rows.push(row);
  }
  let rights = '';
  for (const color of ['w', 'b'] as Color[]) {
    const base = color === 'w' ? 0 : 56, king = position.pieces[color + 'K'];
    if (king?.square !== base + 4 || king.hasMoved) continue;
    for (const [file, flag] of [[7, 'K'], [0, 'Q']] as const) {
      const rook = position.pieces[color + (file === 7 ? 'Rh' : 'Ra')];
      if (rook?.type === 'R' && rook.square === base + file && !rook.hasMoved && !rook.promoted) rights += color === 'w' ? flag : flag.toLowerCase();
    }
  }
  return `${rows.join('/')} ${position.turn} ${rights || '-'} ${position.enPassant === null ? '-' : squareName(position.enPassant)} ${position.halfmoveClock} ${Math.floor((position.ply ?? 0) / 2) + 1}`;
}
export const chessFor = (position: ChessPosition) => new Chess(positionFen(position));
export const positionKey = (chess: Chess) => chess.fen().split(' ').slice(0, 4).join(' ');
export function publicMove(move: ChessMove, pieces: Record<string, Piece>, board: (string | null)[]): Move {
  const from = squareIndex(move.from), to = squareIndex(move.to);
  return { pieceId: board[from]!, from, to,
    ...(move.promotion ? { promotion: move.promotion.toUpperCase() as Promotion } : {}),
    ...(move.flags.includes('k') ? { castle: 'K' as const } : move.flags.includes('q') ? { castle: 'Q' as const } : {}),
    ...(move.flags.includes('e') ? { enPassant: true } : {}) };
}
