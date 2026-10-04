import { t, language, toggleLanguage, colorName, pieceName } from './i18n.js';
import { renderBoard, squareName, crownBadge } from './board.js';
import { withIcon } from './icons.js';
import { pieceGraphic } from './pieces.js';
import { animateBoard } from './board-motion.js';

const app = document.querySelector('#app'), languageButton = document.querySelector('#language');
const roomId = new URLSearchParams(location.search).get('room');
const adminWatch = location.pathname === '/admin/watch';
const fragmentToken = new URLSearchParams(location.hash.slice(1)).get('t');
const token = roomId && !adminWatch ? (fragmentToken || sessionStorage.getItem(`hidden-crown:room:${roomId}`)) : null;
if (roomId && fragmentToken && !adminWatch) sessionStorage.setItem(`hidden-crown:room:${roomId}`, fragmentToken);
let view = null, socket = null, candidate = null, selected = null, pending = false, lockPending = false;
let connection = 'connecting', attempts = 0, reconnectTimer, pingTimer, noticeTimer;
let inviteLinks = null, observerLinks = null, exportKind = null, creating = false;
let createdRoomId = null, joinCode = '', joining = false, joinError = null;
let clockAnchor = { serverNow: 0, receivedAt: 0 }, promotionMoves = null;
let rulesOpen = true, noticeKey = null, lastPong = 0;
let confirmationKey = null, confirmationAction = null;

function node(tag, className, text) {
  const element = document.createElement(tag); if (className) element.className = className;
  if (text !== undefined) element.textContent = text; return element;
}
function button(label, action, className = '', disabled = false, icon = '') {
  const element = node('button', className, label); element.type = 'button'; element.disabled = disabled;
  withIcon(element, label, icon);
  element.addEventListener('click', action); return element;
}
function notice(key) {
  noticeKey = key;
  const element = document.querySelector('#notice'); element.textContent = t(key); element.hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { element.hidden = true; }, 4000);
}
function askConfirmation(key, action) {
  confirmationKey = key; confirmationAction = action; renderConfirmation();
  document.querySelector('#confirmation').showModal();
}
function renderConfirmation() {
  document.querySelector('#confirmation-title').textContent = t('confirmTitle');
  document.querySelector('#confirmation-message').textContent = confirmationKey ? t(confirmationKey) : '';
  withIcon(document.querySelector('#confirmation-accept'), t('confirm'), 'check');
  withIcon(document.querySelector('#confirmation-cancel'), t('cancel'), 'close');
}
document.querySelector('#confirmation-accept').addEventListener('click', () => {
  const action = confirmationAction; confirmationAction = null; confirmationKey = null;
  document.querySelector('#confirmation').close(); action?.();
});
document.querySelector('#confirmation-cancel').addEventListener('click', () => {
  document.querySelector('#confirmation').close(); confirmationAction = null; confirmationKey = null;
});
document.querySelector('#confirmation').addEventListener('cancel', () => { confirmationAction = null; confirmationKey = null; });
async function copy(text, success = 'copied') {
  try { await navigator.clipboard.writeText(text); notice(success); } catch { notice('copyFailed'); }
}
const absolute = relative => new URL(relative, location.origin).href;
function send(message) {
  if (socket?.readyState !== WebSocket.OPEN || connection !== 'connected') return false;
  socket.send(JSON.stringify(message)); return true;
}
function rules() {
  const details = node('details', 'panel'); details.open = rulesOpen;
  details.append(node('summary', '', t('rules')));
  const list = node('ol'); for (let i = 1; i <= 5; i++) list.append(node('li', '', t(`rule${i}`)));
  details.append(list); details.addEventListener('toggle', () => { rulesOpen = details.open; }); return details;
}
function linkRows(links) {
  const panel = node('section', 'panel invites'); panel.append(node('h2', '', t('roomReady')), node('p', 'small', t('linksHelp')));
  if (createdRoomId) {
    const number = node('div', 'room-number-row');
    number.append(node('span', '', t('roomNumber')), node('strong', 'room-number', createdRoomId), button(t('copyRoomNumber'), () => copy(createdRoomId), '', false, 'copy'));
    panel.append(number);
  }
  for (const role of ['white', 'black']) {
    const row = node('div', 'invite-row');
    const label = node('div'); label.append(node('strong', '', t(role)), node('div', 'small', t(role === 'observer' ? 'keep' : 'tester')));
    const input = node('input'); input.readOnly = true; input.value = absolute(links[role]); input.setAttribute('aria-label', t(role));
    input.addEventListener('focus', () => input.select());
    const open = node('a', 'open-link', t('open')); open.href = input.value; open.target = '_blank'; open.rel = 'noopener noreferrer';
    withIcon(open, t('open'), 'open');
    row.append(label, button(t('copy'), () => copy(input.value), '', false, 'copy'), open, input); panel.append(row);
  }
  return panel;
}
function joinPanel() {
  const panel = node('section', 'panel join-panel'); panel.append(node('h2', '', t('joinTitle')));
  const help = node('p', 'small', t('joinHelp')); help.id = 'join-help'; panel.append(help);
  const form = node('form', 'join-form'); form.noValidate = true;
  const label = node('label', 'small', t('roomNumber')); label.htmlFor = 'join-code';
  const input = node('input'); input.id = 'join-code'; input.name = 'room'; input.value = joinCode;
  input.maxLength = 8; input.placeholder = t('roomPlaceholder'); input.autocomplete = 'off'; input.spellcheck = false;
  input.setAttribute('autocapitalize', 'characters'); input.setAttribute('aria-describedby', 'join-help'); input.disabled = joining;
  input.addEventListener('input', () => { joinCode = input.value; });
  const submit = node('button', 'primary', t(joining ? 'joining' : 'join')); submit.type = 'submit'; submit.disabled = joining || creating;
  withIcon(submit, t(joining ? 'joining' : 'join'), 'enter');
  form.append(input, submit); form.addEventListener('submit', event => { event.preventDefault(); joinRoom(); }); panel.append(label, form);
  if (joinError) { const error = node('p', 'join-error', t(joinError)); error.setAttribute('role', 'alert'); panel.append(error); }
  if (/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(joinCode)) {
    const resume = node('div', 'actions resume-actions');
    for (const color of ['w', 'b']) {
      const saved = localStorage.getItem(`hidden-crown:room:${joinCode}:${color}`);
      if (saved) resume.append(button(t('returnAs', { color: colorName(color) }), () => location.assign(`/?room=${joinCode}#t=${encodeURIComponent(saved)}`), '', false, 'back'));
    }
    if (resume.childNodes.length) panel.append(resume);
  }
  return panel;
}
function pickSide() {
  const dialog = document.querySelector('#side-picker');
  document.querySelector('#side-title').textContent = t('chooseSide');
  document.querySelector('#side-help').textContent = t('chooseSideHelp');
  withIcon(document.querySelector('#side-white'), t('white'), 'white'); withIcon(document.querySelector('#side-black'), t('black'), 'black'); withIcon(document.querySelector('#side-cancel'), t('cancel'), 'close');
  dialog.showModal();
}
for (const color of ['w', 'b']) document.querySelector(color === 'w' ? '#side-white' : '#side-black').addEventListener('click', () => { document.querySelector('#side-picker').close(); joinRoom(color); });
document.querySelector('#side-cancel').addEventListener('click', () => document.querySelector('#side-picker').close());
async function joinRoom(color) {
  if (joining || creating) return;
  joinCode = joinCode.trim().toUpperCase(); joinError = null;
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(joinCode)) { joinError = 'join_invalid_room_number'; render(); return; }
  joining = true; render();
  try {
    const response = await fetch(`/api/rooms/${joinCode}/join`, { method: 'POST', ...(color ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color }) } : {}) });
    const data = await response.json();
    if (data.code === 'choose_side') { pickSide(); return; }
    if (!response.ok) { joinError = `join_${data.code}`; return; }
    const target = new URL(data.link, location.origin);
    localStorage.setItem(`hidden-crown:room:${joinCode}:${data.role}`, new URLSearchParams(target.hash.slice(1)).get('t'));
    location.assign(target.href);
  } catch { joinError = 'error_request'; } finally { joining = false; render(); }
}
function renderHome() {
  const home = node('div', 'home'), hero = node('section', 'hero');
  hero.append(node('p', 'eyebrow', t('homeTag')), node('div', 'hero-icon', '♔\uFE0E'), node('h1', '', t('subtitle')), node('p', 'description', t('description')));
  hero.append(button(t(creating ? 'creating' : 'create'), createRoom, 'primary', creating || joining, 'plus'));
  const features = node('div', 'features'); for (const key of ['featureSecret', 'featureRemote', 'featureTime']) features.append(node('span', '', t(key)));
  hero.append(features); home.append(hero);
  home.append(joinPanel());
  if (inviteLinks) home.append(linkRows(inviteLinks));
  home.append(rules()); app.replaceChildren(home);
}
async function createRoom() {
  creating = true; render();
  try {
    const response = await fetch('/api/rooms', { method: 'POST' });
    if (!response.ok) { const data = await response.json().catch(() => ({})); notice(`error_${data.code ?? 'request'}`); return; }
    const data = await response.json(); inviteLinks = data.links; createdRoomId = data.roomId;
  } catch { notice('error_request'); } finally { creating = false; render(); }
}
function presence() {
  const element = node('div', 'presence');
  for (const color of ['w', 'b']) {
    const item = node('span', 'presence-item'); item.title = t(view.connected[color] ? 'connected' : 'offline');
    item.append(node('span', `dot ${view.connected[color] ? 'online' : ''}`), node('span', '', colorName(color))); element.append(item);
  }
  return element;
}
function trays() {
  const panel = node('section', 'panel'); panel.append(node('h2', '', t('captured')));
  const crowns = view.crowns ? Object.values(view.crowns).filter(Boolean) : [view.yourCrown].filter(Boolean);
  for (const color of ['w', 'b']) {
    const tray = node('div', 'tray'); tray.append(node('div', 'tray-label', t(color === 'w' ? 'capturedWhite' : 'capturedBlack')));
    const pieces = node('div', 'tray-pieces');
    for (const piece of Object.values(view.pieces).filter(p => p.color === color && p.square === null)) {
      const wrap = node('span', 'captured-piece'); wrap.title = pieceName(piece);
      wrap.append(pieceGraphic(piece));
      if (crowns.includes(piece.id)) wrap.append(crownBadge(color)); pieces.append(wrap);
    }
    if (!pieces.childNodes.length) pieces.append(node('span', 'small', t('none')));
    tray.append(pieces); panel.append(tray);
  }
  return panel;
}
function moveTable() {
  const panel = node('section', 'panel'), title = node('h2', '', t('moves'));
  panel.append(title);
  if (!view.moves.length) { panel.append(node('div', 'empty-moves', t('noMovesYet'))); return panel; }
  const scroll = node('div', 'move-scroll'), table = node('table'), head = node('thead'), header = node('tr');
  const columns = view.role === 'observer' ? ['ply', 'color', 'notation', 'capturedColumn', 'thinkTime'] : ['ply', 'color', 'notation'];
  for (const key of columns) header.append(node('th', '', t(key))); head.append(header); table.append(head);
  const body = node('tbody');
  for (const move of view.moves) {
    const row = node('tr'); row.append(node('td', '', String(move.ply)), node('td', '', colorName(move.color)), node('td', 'notation', move.notation));
    if (view.role === 'observer') row.append(node('td', '', move.captured ?? '—'), node('td', '', t('seconds', { n: (move.thinkMs / 1000).toFixed(1) })));
    body.append(row);
  }
  table.append(body); scroll.append(table); panel.append(scroll); return panel;
}
function crownDescription(id) {
  const piece = view.pieces[id];
  const originFile = id[2] ?? (id[1] === 'K' ? 'e' : 'd');
  return t('crownOrigin', { color: colorName(piece.color), piece: t(piece.type), square: originFile + (piece.color === 'w' ? '1' : '8') });
}
function resultPanel() {
  const panel = node('section', 'panel result-panel'), result = view.result;
  panel.append(node('p', 'eyebrow', t('ended')), node('h2', '', result.reason === 'admin' ? t('adminEnd') : result.winner ? t('winner', { color: colorName(result.winner) }) : t('draw')));
  let explanation;
  if (result.reason === 'crown_captured') {
    const loser = result.winner === 'w' ? 'b' : 'w';
    explanation = t('crown_captured', { color: colorName(loser), piece: pieceName(view.pieces[view.crowns[loser]]) });
  } else if (result.reason === 'resign') explanation = t('resignReason', { color: colorName(result.winner === 'w' ? 'b' : 'w') });
  else explanation = t(result.reason);
  panel.append(node('p', '', explanation), node('h3', '', t('reveal')));
  for (const id of Object.values(view.crowns ?? {}).filter(Boolean)) {
    const piece = view.pieces[id]; const capture = view.moves.find(m => m.captured === id);
    let text = crownDescription(id);
    if (piece.square === null && capture) text += ' · ' + t('capturedAt', { square: squareName(capture.to) });
    panel.append(node('p', 'reveal-lines', text));
  }
  return panel;
}
function observerPanel() {
  const panel = node('section', 'panel'), stats = node('div', 'observer-stats');
  const phase = node('div'); phase.append(node('span', 'stat-label', t('phase')), node('span', 'stat-value', t(view.phase === 'ended' ? 'endedPhase' : view.phase)));
  const think = node('div'); think.append(node('span', 'stat-label', t('thinking')));
  const timer = node('span', 'stat-value'); timer.id = 'think-timer'; think.append(timer); stats.append(phase, think); panel.append(stats);
  for (const color of ['w', 'b']) {
    const id = view.crowns?.[color];
    panel.append(node('p', 'small', id ? crownDescription(id) : `${colorName(color)} · ${t('crownUnchosen')}`));
  }
  const actions = node('div', 'actions');
  actions.append(button(t('copyPlayerLinks'), () => {
    if (observerLinks) copy(`${colorName('w')}: ${absolute(observerLinks.white)}\n${colorName('b')}: ${absolute(observerLinks.black)}`, 'playerLinksCopied');
    else send({ type: 'get_links' });
  }, '', !observerLinks || connection !== 'connected', 'copy'));
  for (const kind of ['JSON', 'CSV']) actions.append(button(t(exportKind === kind ? 'exporting' : `export${kind}`), () => {
    exportKind = kind; if (!send({ type: 'get_log' })) exportKind = null; render();
  }, '', connection !== 'connected' || !!exportKind, 'download'));
  panel.append(actions); return panel;
}
function playerControls() {
  const panel = node('section', 'panel');
  if (view.phase === 'crown_select') {
    panel.append(node('h2', '', t('select')));
    if (view.crownLocked[view.role]) panel.append(node('p', 'small', t('lockedWaiting')));
    else {
      panel.append(node('p', 'small', t('selectHelp')), node('p', 'selection-status', candidate ? t('selectedCrown', { piece: pieceName(view.pieces[candidate]) }) : ''));
      panel.append(button(t('lock'), () => {
        if (candidate) askConfirmation('lockConfirm', () => { lockPending = send({ type: 'select_crown', pieceId: candidate }); render(); });
      }, 'primary', !candidate || lockPending || connection !== 'connected', 'lock'));
    }
  } else if (view.phase === 'playing') {
    if (view.yourCrown) panel.append(node('p', 'small', t('ownCrown', { piece: pieceName(view.pieces[view.yourCrown]) })));
    const actions = node('div', 'actions');
    actions.append(button(t('offerDraw'), () => send({ type: 'offer_draw' }), '', !!view.drawOffer || connection !== 'connected', 'draw'));
    actions.append(button(t('resign'), () => askConfirmation('resignConfirm', () => send({ type: 'resign' })), 'danger quiet-button', connection !== 'connected', 'flag'));
    panel.append(actions);
    if (view.drawOffer) {
      const bar = node('div', 'draw-bar'); bar.append(node('p', 'small', t(view.drawOffer === view.role ? 'drawSent' : 'drawReceived')));
      if (view.drawOffer !== view.role) {
        const responses = node('div', 'actions');
        responses.append(button(t('accept'), () => send({ type: 'respond_draw', accept: true }), 'primary', connection !== 'connected', 'check'), button(t('decline'), () => send({ type: 'respond_draw', accept: false }), '', connection !== 'connected', 'close')); bar.append(responses);
      }
      panel.append(bar);
    }
  }
  return panel;
}
function statusText() {
  if (view.phase === 'lobby') return t('waiting');
  if (view.phase === 'crown_select') return t(view.role === 'observer' ? 'crown_select' : view.crownLocked[view.role] ? 'lockedWaiting' : 'select');
  if (view.phase === 'ended') return t('ended');
  if (pending) return t('movePending');
  return view.role === 'observer' ? t('turn', { color: colorName(view.turn) }) : t(view.turn === view.role ? 'yourTurn' : 'opponentThinking');
}
function renderGame() {
  const scrollPosition = app.querySelector('.move-scroll')?.scrollTop;
  const page = node('div');
  if (view.role === 'observer') page.append(node('div', 'banner observer-banner', t('observerWarning')));
  if (connection !== 'connected') page.append(node('div', 'banner', t(connection)));
  if (view.phase === 'playing') for (const color of ['w', 'b']) if (!view.connected[color]) page.append(node('div', 'banner', t('peerOffline', { color: colorName(color) })));
  const heading = node('div', 'game-heading'), title = node('div');
  title.append(node('div', 'room-label', `${t('room')} ${roomId}`), node('h1', '', statusText()));
  heading.append(title, node('div', 'small', view.role === 'observer' ? t('observer') : t('youAre', { color: colorName(view.role) }))); page.append(heading);
  if (view.phase === 'ended' && view.result) page.append(resultPanel());
  const layout = node('div', 'game-layout'), boardColumn = node('div', 'board-column'), boardContainer = node('div');
  const enabled = connection === 'connected' && !pending && !lockPending && view.role !== 'observer' &&
    ((view.phase === 'playing' && view.turn === view.role) || (view.phase === 'crown_select' && !view.crownLocked[view.role]));
  renderBoard(boardContainer, view, { selected, candidate, enabled, onSquare }); boardColumn.append(boardContainer);
  const status = node('div', 'board-status'); status.append(node('span', 'muted', statusText()), presence()); boardColumn.append(status);
  const sidebar = node('aside', 'sidebar');
  if (view.role === 'observer') sidebar.append(observerPanel());
  else if (view.phase === 'playing' || view.phase === 'crown_select') sidebar.append(playerControls());
  sidebar.append(trays(), moveTable(), rules()); layout.append(boardColumn, sidebar); page.append(layout); app.replaceChildren(page);
  const scroll = app.querySelector('.move-scroll'); if (scroll && scrollPosition !== undefined) scroll.scrollTop = scrollPosition;
  animateBoard(boardContainer.querySelector('.board'), view);
  updateTimer();
}
function render() {
  renderConfirmation();
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; withIcon(languageButton, language === 'en' ? '中文' : 'EN', 'language');
  document.querySelector('#promotion-title').textContent = t('selectPromotion'); withIcon(document.querySelector('#promotion-cancel'), t('cancel'), 'close');
  if (!roomId) { renderHome(); return; }
  if (!view) {
    const panel = node('section', 'panel home'); panel.append(node('h1', '', 'Hidden Crown'), node('p', '', t(token || adminWatch ? connection : 'missingToken')));
    if ((token || adminWatch) && connection === 'connectionFailed') panel.append(button(t('retry'), connect, 'primary', false, 'refresh'));
    app.replaceChildren(panel); return;
  }
  renderGame();
}
function onSquare(square) {
  if (view.phase === 'crown_select') {
    const piece = view.pieces[view.board[square]];
    candidate = piece?.color === view.role && piece.type !== 'P' && !piece.promoted ? piece.id : null; render(); return;
  }
  const moves = (view.legalMoves ?? []).filter(m => m.from === selected && m.to === square);
  if (moves.length > 1) { openPromotion(moves); return; }
  if (moves.length === 1) { submitMove(moves[0]); return; }
  const piece = view.pieces[view.board[square]];
  selected = selected !== square && piece?.color === view.role ? square : null; render();
}
function submitMove(move) {
  pending = send({ type: 'move', from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
  selected = null; render();
}
function openPromotion(moves) {
  promotionMoves = moves;
  const choices = document.querySelector('#promotion-choices'); choices.replaceChildren();
  for (const move of moves) {
    const choice = button('', () => {
      document.querySelector('#promotion').close(); promotionMoves = null; submitMove(move);
    });
    choice.append(pieceGraphic({ color: view.role, type: move.promotion })); choice.setAttribute('aria-label', t(move.promotion)); choices.append(choice);
  }
  document.querySelector('#promotion').showModal();
}
document.querySelector('#promotion-cancel').addEventListener('click', () => { document.querySelector('#promotion').close(); promotionMoves = null; });
document.querySelector('#promotion').addEventListener('cancel', () => { promotionMoves = null; });
languageButton.addEventListener('click', () => {
  toggleLanguage(); render();
  if (promotionMoves && document.querySelector('#promotion').open) {
    document.querySelector('#promotion').close(); openPromotion(promotionMoves);
  }
  const message = document.querySelector('#notice'); if (noticeKey && !message.hidden) message.textContent = t(noticeKey);
});
function updateTimer() {
  const timer = document.querySelector('#think-timer'); if (!timer || !view) return;
  const start = view.lastMoveAt ?? view.playStartedAt;
  if (view.phase !== 'playing' || start === null) timer.textContent = '—';
  else timer.textContent = t('seconds', { n: Math.max(0, (clockAnchor.serverNow + performance.now() - clockAnchor.receivedAt - start) / 1000).toFixed(1) });
}
setInterval(updateTimer, 200);
function downloadLog(message) {
  const kind = exportKind; exportKind = null;
  if (!kind) return;
  let content, mime;
  if (kind === 'JSON') { content = JSON.stringify(message, null, 2); mime = 'application/json'; }
  else {
    const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    content = ['ply,color,notation,piece_id,captured_id,think_ms,timestamp_iso', ...message.moves.map(move =>
      [move.ply, move.color, move.notation, move.pieceId, move.captured ?? '', move.thinkMs, new Date(move.at).toISOString()].map(escape).join(','))].join('\r\n');
    mime = 'text/csv;charset=utf-8';
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = node('a'); a.href = url; a.download = `hidden-crown-${roomId}.${kind.toLowerCase()}`; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); render();
}
function connect() {
  if (!token && !adminWatch) return;
  clearTimeout(reconnectTimer); clearInterval(pingTimer);
  if (socket) { socket.onclose = null; socket.close(); }
  connection = view ? 'reconnecting' : 'connecting'; render();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${encodeURIComponent(roomId)}${adminWatch ? '?admin=1' : ''}`); socket = ws;
  const timeout = setTimeout(() => { if (connection !== 'connected' && socket === ws) ws.close(); }, 12000);
  ws.onopen = () => { if (!adminWatch) ws.send(JSON.stringify({ type: 'hello', token })); };
  ws.onmessage = event => {
    if (socket !== ws) return;
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'welcome') {
      if (!adminWatch && ['w', 'b'].includes(message.role)) localStorage.setItem(`hidden-crown:room:${roomId}:${message.role}`, token);
      clearTimeout(timeout); connection = 'connected'; attempts = 0; lastPong = Date.now();
      pingTimer = setInterval(() => {
        if (Date.now() - lastPong > 65000) ws.close(); else send({ type: 'ping' });
      }, 25000);
      if (message.role === 'observer') send({ type: 'get_links' });
    } else if (message.type === 'state') {
      const oldPly = view?.moves.length, oldPhase = view?.phase;
      view = message.view; clockAnchor = { serverNow: view.serverNow, receivedAt: performance.now() };
      if (oldPly !== view.moves.length || oldPhase !== view.phase) { selected = null; document.querySelector('#promotion').close(); promotionMoves = null; }
      pending = false; lockPending = false; render();
    } else if (message.type === 'pong') lastPong = Date.now();
    else if (message.type === 'links') { observerLinks = message.links; render(); }
    else if (message.type === 'log') downloadLog(message);
    else if (message.type === 'error') {
      pending = false; lockPending = false; exportKind = null; notice(`error_${message.code}`); render();
    }
  };
  ws.onclose = event => {
    if (socket !== ws) return;
    clearTimeout(timeout); clearInterval(pingTimer); pending = false; lockPending = false; exportKind = null;
    selected = null; document.querySelector('#promotion').close(); promotionMoves = null;
    document.querySelector('#confirmation').close(); confirmationKey = null; confirmationAction = null;
    if (event.code === 4000 || event.code === 4001) { connection = event.code === 4000 ? 'replaced' : 'badToken'; render(); return; }
    connection = view ? 'reconnecting' : 'connectionFailed'; render();
    const delay = [1000, 2000, 4000, 8000][attempts++] ?? 10000;
    reconnectTimer = setTimeout(connect, delay);
  };
  ws.onerror = () => { /* onclose owns reconnect and visible feedback. */ };
}
render(); if (roomId && (token || adminWatch)) connect();
