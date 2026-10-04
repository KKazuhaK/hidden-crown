import { t, pieceName } from './i18n.js';
import { pieceGraphic, crownMark } from './pieces.js';
export const squareName = square => 'abcdefgh'[square % 8] + (Math.floor(square / 8) + 1);
export function canCrown(piece, version = 3) {
  return !!piece && /^[wb](K|Q|R[ah]|B[cf]|N[bg])$/.test(piece.id) && !piece.promoted && piece.square !== null && (version === 1 || piece.type !== (version === 2 ? 'Q' : 'K'));
}
export function crownBadge(color) {
  const badge = document.createElement('span'); badge.className = `crown-badge crown-${color}`;
  badge.append(crownMark()); badge.setAttribute('aria-label', t('crownBadge')); return badge;
}
// Use only answers visible in this view and in the currently replayed history.
export function interrogationKnowledge(view) {
  return Object.fromEntries(view.moves.filter(move => move.kind === 'interrogation' &&
    (view.role === 'observer' || move.color === view.role) &&
    ['clear', 'crown'].includes(move.answer)).map(move => [move.targetId, move.answer]));
}
export function interrogationBadge(answer, color) {
  if (!['clear', 'crown'].includes(answer)) return null;
  const badge = answer === 'crown' ? crownBadge(color) : document.createElement('span');
  if (answer === 'clear') { badge.className = 'interrogation-clear-badge'; badge.textContent = '×'; }
  badge.title = t(`interrogation_${answer}`);
  badge.setAttribute('aria-label', badge.title);
  return badge;
}
export function renderBoard(container, view, options) {
  const { selected, candidate, enabled, onSquare, interrogating } = options;
  const flipped = view.role === 'b';
  const crowns = view.crowns ? Object.values(view.crowns).filter(Boolean) : [view.yourCrown].filter(Boolean);
  const knowledge = interrogationKnowledge(view);
  const last = view.moves.at(-1);
  const targets = (view.legalMoves ?? []).filter(move => move.from === selected);
  const board = document.createElement('div'); board.className = 'board'; board.setAttribute('aria-label', t('board'));
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      const rank = flipped ? row : 7 - row, file = flipped ? 7 - column : column, square = rank * 8 + file;
      const id = view.board[square], piece = id ? view.pieces[id] : null;
      const target = targets.find(m => m.to === square);
      const button = document.createElement('button'); button.type = 'button'; button.className = `square ${(rank + file) % 2 ? 'light' : 'dark'}`;
      button.dataset.square = squareName(square); button.disabled = !enabled;
      button.setAttribute('aria-label', t('squareLabel', { square: squareName(square), piece: piece ? pieceName(piece) : t('empty') }));
      if (last && (last.from === square || (last.kind === 'interrogation' ? last.targetSquare === square : last.to === square))) button.classList.add('last-move');
      if (selected === square || (candidate && candidate === id)) button.classList.add('selected');
      if (view.phase === 'crown_select' && view.role !== 'observer' && !view.crownLocked[view.role] && piece?.color === view.role && canCrown(piece, view.ruleset.version)) button.classList.add('candidate');
      if (piece) {
        const motion = document.createElement('span'); motion.className = 'piece-motion'; motion.dataset.pieceId = id;
        motion.append(pieceGraphic(piece));
        if (crowns.includes(id)) motion.append(crownBadge(piece.color));
        else if (knowledge[id]) motion.append(interrogationBadge(knowledge[id], piece.color));
        if (knowledge[id]) {
          button.title = t(`interrogation_${knowledge[id]}`);
          button.setAttribute('aria-label', `${button.getAttribute('aria-label')} · ${button.title}`);
        }
        button.append(motion);
      }
      if (interrogating ? view.interrogationTargets?.includes(id) : target) {
        const marker = document.createElement('span'); marker.className = target?.enPassant || piece ? 'target capture-target' : 'target quiet-target'; button.append(marker);
      }
      if (column === 0) { const label = document.createElement('span'); label.className = 'rank-label'; label.textContent = String(rank + 1); button.append(label); }
      if (row === 7) { const label = document.createElement('span'); label.className = 'file-label'; label.textContent = 'abcdefgh'[file]; button.append(label); }
      button.addEventListener('click', () => onSquare(square)); board.append(button);
    }
  }
  container.replaceChildren(board);
}
