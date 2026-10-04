// Reconstruct only public piece positions. Crown visibility comes from the current,
// already-redacted view; replay never requests privileged data.
export function replayAt(view, ply) {
  const count = Math.max(0, Math.min(view.moves.length, Math.trunc(ply)));
  const pieces = {}, board = Array(64).fill(null);
  for (const piece of Object.values(view.pieces)) {
    const type = piece.id[1], file = 'abcdefgh'.indexOf(piece.id[2] ?? (type === 'K' ? 'e' : 'd'));
    const rank = piece.color === 'w' ? (type === 'P' ? 1 : 0) : (type === 'P' ? 6 : 7);
    const square = rank * 8 + file;
    pieces[piece.id] = { ...piece, type, square, hasMoved: false, promoted: false };
    board[square] = piece.id;
  }
  const place = (id, square) => {
    const piece = pieces[id];
    if (piece.square !== null) board[piece.square] = null;
    piece.square = square; if (square !== null) piece.hasMoved = true;
    if (square !== null) board[square] = id;
  };
  for (const move of view.moves.slice(0, count)) {
    if (move.captured) place(move.captured, null);
    place(move.pieceId, move.to);
    if (move.castle) {
      const base = move.color === 'w' ? 0 : 56;
      place(move.color + (move.castle === 'K' ? 'Rh' : 'Ra'), base + (move.castle === 'K' ? 5 : 3));
    }
    if (move.promotion) { pieces[move.pieceId].type = move.promotion; pieces[move.pieceId].promoted = true; }
  }
  return { ...view, pieces, board, moves: view.moves.slice(0, count), turn: count % 2 ? 'b' : 'w', legalMoves: [], phase: 'playing' };
}
