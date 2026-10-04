import { pieceGraphic } from './pieces.js';

// Permanent IDs cover rook movement during castling and the pawn identity after promotion.
export function boardTransitions(before, after) {
  if (!before || before.role !== after.role || after.moves.length !== before.moves.length + 1) return [];
  const changes = [];
  for (const [id, previous] of Object.entries(before.pieces)) {
    const next = after.pieces[id];
    if (previous.square === null || !next || previous.square === next.square) continue;
    changes.push({ id, previous, next, from: previous.square, to: next.square });
  }
  return changes;
}

let previousView = null, motion = [], startedAt = 0;
const duration = 360;
export function animateBoard(board, view) {
  const changed = previousView !== view;
  if (changed && (!previousView || previousView.moves.length !== view.moves.length)) {
    motion = boardTransitions(previousView, view); startedAt = performance.now();
  }
  previousView = view;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !board.animate) { motion = []; return; }
  const elapsed = performance.now() - startedAt;
  if (elapsed >= duration) { motion = []; return; }
  const remaining = duration - elapsed, progress = elapsed / duration;
  const cell = board.clientWidth / 8, flipped = view.role === 'b';
  const position = square => ({ x: (flipped ? 7 - square % 8 : square % 8) * cell, y: (flipped ? Math.floor(square / 8) : 7 - Math.floor(square / 8)) * cell });
  for (const move of motion) {
    const from = position(move.from);
    if (move.to === null) {
      const ghost = document.createElement('div'); ghost.className = 'capture-ghost';
      ghost.style.cssText = `left:${from.x}px;top:${from.y}px;width:${cell}px;height:${cell}px`;
      ghost.setAttribute('aria-hidden', 'true'); ghost.append(pieceGraphic(move.previous));
      // The decorative ghost has no crown metadata, preserving hidden-information rules.
      board.append(ghost);
      const animation = ghost.animate([{ opacity: 1 - progress, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.8)' }], { duration: remaining, easing: 'ease-out' });
      animation.onfinish = () => ghost.remove();
      continue;
    }
    const target = [...board.querySelectorAll('.piece-motion')].find(element => element.dataset.pieceId === move.id);
    if (!target) continue;
    const to = position(move.to), fraction = (1 - progress) ** 3;
    if (move.previous.type !== move.next.type) target.querySelector('.piece').replaceWith(pieceGraphic(move.previous));
    target.classList.add('is-moving');
    const animation = target.animate([{ transform: `translate(${(from.x - to.x) * fraction}px,${(from.y - to.y) * fraction}px)` }, { transform: 'translate(0,0)' }], { duration: remaining, easing: 'cubic-bezier(.2,.8,.2,1)' });
    animation.onfinish = () => {
      target.classList.remove('is-moving');
      if (move.previous.type !== move.next.type) target.querySelector('.piece')?.replaceWith(pieceGraphic(move.next));
    };
  }
}
