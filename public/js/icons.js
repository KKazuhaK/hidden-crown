const paths = {
  sound: ['M11 4 6 8H3v8h3l5 4z', 'M15 8a6 6 0 0 1 0 8', 'M18 5a10 10 0 0 1 0 14'],
  muted: ['M11 4 6 8H3v8h3l5 4z', 'm16 9 5 6', 'm21 9-5 6'],
  computer: ['M5 7h14v12H5z', 'M12 3v4', 'M2 11h3', 'M19 11h3', 'M8 19v2', 'M16 19v2', 'M8 11h1', 'M15 11h1', 'M9 15h6'],
  book: ['M12 5v16', 'M12 5C9 2 5 3 3 4v15c3-1 6-1 9 2', 'M12 5c3-3 7-2 9-1v15c-3-1-6-1-9 2'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  open: ['M14 4h6v6', 'M20 4 10 14', 'M10 4H4v16h16v-6'],
  plus: ['M12 5v14', 'M5 12h14'],
  enter: ['M14 4h6v16h-6', 'M3 12h12', 'm10 7 5 5-5 5'],
  back: ['M9 5 3 11l6 6', 'M3 11h11a6 6 0 0 1 6 6v2'],
  check: ['m5 12 4 4L19 6'],
  close: ['m6 6 12 12', 'M18 6 6 18'],
  white: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
  black: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
  download: ['M12 3v12', 'm7 10 5 5 5-5', 'M4 16v5h16v-5'],
  lock: ['M5 10h14v11H5z', 'M8 10V6a4 4 0 0 1 8 0v4'],
  flag: ['M5 21V3', 'M5 3h14l-3 4 3 4H5'],
  draw: ['M4 9h16', 'M4 15h16'],
  refresh: ['M21 3v5h-5', 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8'],
  eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  trash: ['M3 6h18', 'M9 6V3h6v3', 'M5 6l1 15h12l1-15', 'M10 10v7', 'M14 10v7'],
  stop: ['M5 5h14v14H5z'],
  left: ['m15 5-7 7 7 7'],
  right: ['m9 5 7 7-7 7'],
  language: ['M3 4h12', 'M9 2v2', 'M5 4c1 5 4 9 9 11', 'M13 4c-1 5-4 9-9 11', 'm13 21 4-10 4 10', 'M15 17h4']
};

// Keep the text as the accessible name; icons are decorative and use no remote assets.
export function withIcon(element, label, name) {
  element.textContent = label;
  if (!paths[name]) return element;
  element.classList.add('button-with-icon');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: name === 'black' ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
  svg.classList.add('button-icon');
  for (const d of paths[name]) { const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path); }
  element.prepend(svg); return element;
}
