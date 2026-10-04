const svgNS = 'http://www.w3.org/2000/svg';
// Original vector silhouettes; identical geometry for both colors, independent of fonts.
const shapes = {
  P: [['circle', { cx: 32, cy: 15, r: 7 }], ['path', { d: 'M27 22h10c-2 9-1 14 5 20H22c6-6 7-11 5-20Z' }]],
  R: [['path', { d: 'M17 8h7v7h5V8h6v7h5V8h7v15l-6 4 1 15H22l1-15-6-4Z' }], ['path', { d: 'M23 27h18M22 21h20', class: 'piece-detail' }]],
  B: [['circle', { cx: 32, cy: 8, r: 3 }], ['path', { d: 'M32 12c-7 5-12 11-10 17 1 3 4 5 7 6l-6 7h18l-6-7c3-1 6-3 7-6 2-6-3-12-10-17Z' }], ['path', { d: 'm35 17-8 10M26 34h12', class: 'piece-detail' }]],
  N: [['path', { d: 'M20 42c0-11 5-17 15-20l-8 1-8 7-7-5 7-12 9-4 4-5 4 7c10 3 14 14 10 31Z' }], ['path', { d: 'M30 13c10 6 13 14 10 22M14 24l7-1', class: 'piece-detail' }], ['circle', { cx: 27, cy: 16, r: 1.8, class: 'piece-eye' }]],
  Q: [['path', { d: 'm16 16 7 24h18l7-24-10 9-6-13-6 13Z' }], ['circle', { cx: 16, cy: 13, r: 3 }], ['circle', { cx: 32, cy: 9, r: 3 }], ['circle', { cx: 48, cy: 13, r: 3 }], ['path', { d: 'M23 34h18', class: 'piece-detail' }]],
  K: [['path', { d: 'M29 4h6v6h6v6h-6v6h-6v-6h-6v-6h6Z' }], ['path', { d: 'M32 25c-12-13-20 0-12 11l4 6h16l4-6c8-11 0-24-12-11Z' }], ['path', { d: 'M32 25v11M24 36h16', class: 'piece-detail' }]]
};
function svgElement(tag, attributes) {
  const element = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}
export function pieceGraphic(piece) {
  const wrapper = document.createElement('span'); wrapper.className = `piece piece-${piece.color}`;
  wrapper.setAttribute('aria-hidden', 'true');
  const svg = svgElement('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true', focusable: 'false' });
  for (const [tag, attributes] of shapes[piece.type]) svg.append(svgElement(tag, attributes));
  svg.append(svgElement('path', { d: 'M22 42h20l3 5H19Z' }));
  svg.append(svgElement('path', { d: 'M19 47h26l4 8H15Z' }));
  svg.append(svgElement('path', { d: 'M20 51h24', class: 'piece-detail' }));
  wrapper.append(svg); return wrapper;
}
export function crownMark() {
  const svg = svgElement('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
  svg.append(svgElement('path', { d: 'm3 6 5 4 4-7 4 7 5-4-3 12H6Z', fill: 'currentColor' }));
  return svg;
}
