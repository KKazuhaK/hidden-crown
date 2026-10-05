import { t, language, toggleLanguage, colorName, pieceName } from './i18n.js';
import { renderBoard, squareName, crownBadge, canCrown, interrogationKnowledge, interrogationBadge } from './board.js';
import { withIcon } from './icons.js';
import { pieceGraphic } from './pieces.js';
import { animateBoard, resetBoardMotion } from './board-motion.js';
import { replayAt, canReplay, followReplayRow } from './replay.js';
import { createTurnSound, startsYourTurn } from './turn-sound.js';
import { recordsCsv, actionLabel, thinkingSeconds } from './game-records.js';

const app = document.querySelector('#app'), languageButton = document.querySelector('#language');
const createButton = document.querySelector('#create-room');
createButton.addEventListener('click', () => location.assign('/create'));
const params = new URLSearchParams(location.search), createPage = location.pathname === '/create', rulesPage = location.pathname === '/rules';
const roomId = createPage || rulesPage ? null : params.get('room');
document.querySelector('#show-rules').addEventListener('click', () => roomId || createPage ? openRulesDialog() : location.assign('/rules'));
document.querySelector('#rules-close').addEventListener('click', () => document.querySelector('#rules-dialog').close());
const adminWatch = location.pathname === '/admin/watch';
const fragmentToken = new URLSearchParams(location.hash.slice(1)).get('t');
const token = roomId && !adminWatch ? (fragmentToken || sessionStorage.getItem(`hidden-crown:room:${roomId}`)) : null;
const turnSound = createTurnSound();
for (const event of ['pointerdown', 'keydown']) document.addEventListener(event, () => { if (roomId && token && !adminWatch) turnSound.unlock(); }, { capture: true });
if (roomId && fragmentToken && !adminWatch) sessionStorage.setItem(`hidden-crown:room:${roomId}`, fragmentToken);
let view = null, socket = null, candidate = null, selected = null, pending = false, lockPending = false;
let connection = 'connecting', attempts = 0, reconnectTimer, pingTimer, noticeTimer;
let inviteLinks = null, observerLinks = null, exportKind = null, creating = false;
let createdRoomId = null, joinCode = '', joining = false, joinError = null;
let clockAnchor = { serverNow: 0, receivedAt: 0 }, promotionMoves = null;
let rulesOpen = true, noticeKey = null, noticeValues = {}, lastPong = 0;
let confirmationKey = null, confirmationAction = null;
let replayPly = null;
let interrogating = false;
let connectAttempt = 0;
let createMode = params.get('mode') === 'computer' ? 'computer' : 'friends', difficulty = 'medium', humanColor = 'w';
let createRules = params.get('rules') === 'standard-chess' ? 'standard-chess' : 'hidden-crown';
const standardMode = () => (view?.ruleset?.id ?? createRules) === 'standard-chess';
const modeName = () => t(standardMode() ? 'standardMode' : 'hiddenMode');
let computerAvailable = false, capabilitiesLoaded = false;
let creationError = null;
if (createPage && params.get('room')) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(`hidden-crown:created:${params.get('room')}`));
    if (saved?.roomId === params.get('room') && saved.links?.white && saved.links?.black) { inviteLinks = saved.links; createdRoomId = saved.roomId; createRules = saved.ruleset?.id ?? 'hidden-crown'; }
  } catch { /* Missing browser session returns to the creation form. */ }
}
const displayedView = () => replayPly === null ? view : replayAt(view, replayPly);

function node(tag, className, text) {
  const element = document.createElement(tag); if (className) element.className = className;
  if (text !== undefined) element.textContent = text; return element;
}
function button(label, action, className = '', disabled = false, icon = '') {
  const element = node('button', className, label); element.type = 'button'; element.disabled = disabled;
  withIcon(element, label, icon);
  element.addEventListener('click', action); return element;
}
function notice(key, values = {}) {
  noticeKey = key; noticeValues = values;
  const element = document.querySelector('#notice'); element.textContent = ruleText(key, values); element.hidden = false;
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
  if (replayPly !== null && ['move', 'interrogate', 'select_crown', 'resign', 'offer_draw', 'respond_draw', 'request_undo', 'respond_undo', 'rule_action'].includes(message.type)) return false;
  if (socket?.readyState !== WebSocket.OPEN || connection !== 'connected') return false;
  socket.send(JSON.stringify(message)); return true;
}
function ruleText(key, values = {}) {
  if (standardMode() && key === 'error_undo_disabled') return t('standardUndoDisabled');
  if (standardMode() && key.startsWith('rule') && /^rule\d+$/.test(key)) return t(`standard_${key}`, values);
  const version = view?.ruleset?.version ?? 3;
  if (version === 1 && ['rule1', 'selectHelp'].includes(key)) key = key === 'rule1' ? 'legacyRule1' : 'legacySelectHelp';
  else if (version === 2 && ['rule1', 'rule7', 'selectHelp', 'interrogateHelp', 'error_invalid_interrogation'].includes(key)) key = `queen_${key}`;
  if (version < 3 && key === 'rule3') key = 'legacyRule3';
  return t(key, values);
}
function rules(open = rulesOpen) {
  const details = node('details', 'panel'); details.open = open;
  details.append(node('summary', '', t('rules')));
  const options = view?.ruleset?.options ?? { castling: true, enPassant: true, drawPlyLimit: 100 };
  const legacy = !standardMode() && view?.ruleset?.version === 1;
  const list = node('ol'); for (let i = 1; i <= (standardMode() ? 10 : legacy ? 5 : 8); i++) list.append(node('li', '', !standardMode() && i === 4 && (!options.castling || !options.enPassant) ? t('specialMoves', { castling: t(options.castling ? 'enabled' : 'disabled'), enPassant: t(options.enPassant ? 'enabled' : 'disabled') }) : ruleText(`rule${i}`, { plies: options.drawPlyLimit })));
  details.append(list); details.addEventListener('toggle', () => { rulesOpen = details.open; }); return details;
}
function openRulesDialog() {
  renderRulesDialog(); document.querySelector('#rules-dialog').showModal();
}
function renderRulesDialog() {
  document.querySelector('#rules-dialog-title').textContent = `${t('rules')} · ${modeName()}`;
  document.querySelector('#rules-dialog-content').replaceChildren(rules(true), node('p', 'rules-extra', t(standardMode() ? 'standardRulesExtra' : 'rulesExtra')));
  withIcon(document.querySelector('#rules-close'), t('closeRules'), 'close');
}
function linkRows(links) {
  const panel = node('section', 'panel invites'); panel.append(node('h2', '', t('roomReady')), node('p', 'small', t('linksHelp')));
  panel.append(node('p', 'small', modeName()));
  if (createdRoomId) {
    const number = node('div', 'room-number-row');
    number.append(node('span', '', t('roomNumber')), node('strong', 'room-number', createdRoomId), button(t('copyRoomNumber'), () => copy(createdRoomId), '', false, 'copy'));
    panel.append(number);
  }
  for (const role of ['white', 'black']) {
    if (!links[role]) continue;
    const row = node('div', 'invite-row');
    const label = node('div'); label.append(node('strong', '', t(role)));
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
  const help = node('p', 'small', t('joinIntro')); help.id = 'join-help'; panel.append(help);
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
function homeTitle() {
  const title = node('h1');
  title.append(node('span', 'hero-title-line', t('homeTitleLead')), node('span', 'hero-title-line', t('homeTitleSecret')));
  return title;
}
function renderHome() {
  const home = node('div', 'home'), hero = node('section', 'hero');
  hero.append(node('p', 'eyebrow', t('homeTag')), node('div', 'hero-icon', '♔\uFE0E'), homeTitle(), node('p', 'description', t('description')));
  hero.append(joinPanel());
  const practice = node('div', 'home-play-options');
  if (computerAvailable) practice.append(button(t('playComputer'), () => location.assign('/create?mode=computer'), '', false, 'computer'));
  practice.append(button(t('learnStandard'), () => location.assign(computerAvailable ? '/create?mode=computer&rules=standard-chess' : '/create?rules=standard-chess'), '', false, 'book'));
  hero.append(practice);
  const features = node('div', 'features'); for (const key of ['featureSecret', 'featureRemote', 'featureTime']) features.append(node('span', '', t(key)));
  hero.append(features); home.append(hero);
  app.replaceChildren(home);
}
function selectField(label, id, options, value, changed) {
  const field = node('div', 'create-field'), text = node('label', '', label); text.htmlFor = id;
  const select = node('select'); select.id = id; select.disabled = creating;
  for (const [key, name] of options) { const option = node('option', '', name); option.value = key; select.append(option); }
  select.value = value; select.addEventListener('change', () => changed(select.value)); field.append(text, select); return field;
}
function renderCreate() {
  const page = node('div', 'create-page');
  if (inviteLinks) {
    page.append(linkRows(inviteLinks));
    const actions = node('div', 'actions page-actions');
    actions.append(button(t('backHome'), () => location.assign('/'), '', false, 'back'), button(t('createAnother'), () => location.assign('/create'), '', false, 'plus'));
    page.append(actions); app.replaceChildren(page); return;
  }
  const panel = node('section', 'panel'); panel.append(node('h1', '', t('create')), node('p', 'small', t('createIntro')));
  const form = node('form', 'create-form');
  form.append(selectField(t('gameMode'), 'game-mode', [['friends', t('playFriend')], ['computer', t('playComputer')]], createMode, value => { createMode = value; render(); }));
  form.append(selectField(t('chessRules'), 'chess-rules', [['hidden-crown', t('hiddenModeDefault')], ['standard-chess', t('standardMode')]], createRules, value => { createRules = value; render(); }));
  const help = node('p', 'small', t(standardMode() ? 'standardModeHelp' : 'hiddenModeHelp'));
  const preview = node('button', 'quiet-button'); preview.type = 'button'; withIcon(preview, t('rules'), 'book'); preview.addEventListener('click', openRulesDialog);
  form.append(help, preview);
  if (createMode === 'computer') {
    form.append(selectField(t('difficulty'), 'computer-difficulty', ['easy', 'medium', 'hard'].map(key => [key, t(`difficulty_${key}`)]), difficulty, value => { difficulty = value; }));
    form.append(selectField(t('yourSide'), 'human-color', [['w', t('white')], ['b', t('black')], ['random', t('randomSide')]], humanColor, value => { humanColor = value; }));
    form.append(node('p', 'small', t(standardMode() ? 'standardComputerHelp' : 'computerHelp')));
    if (!computerAvailable) form.append(node('p', 'small', t(capabilitiesLoaded ? 'error_computer_unavailable' : 'connecting')));
  }
  const submit = node('button', 'primary'); submit.type = 'submit';
  withIcon(submit, t(creating ? 'creating' : createMode === 'computer' ? 'startComputer' : 'create'), createMode === 'computer' ? 'computer' : 'plus');
  submit.disabled = creating || (createMode === 'computer' && !computerAvailable);
  form.append(submit); form.addEventListener('submit', event => { event.preventDefault(); createRoom(); }); panel.append(form);
  if (creationError) { const alert = node('p', 'join-error', t(creationError.key, creationError.values)); alert.setAttribute('role', 'alert'); panel.append(alert); }
  page.append(panel); app.replaceChildren(page);
}
function renderRulesPage() {
  const page = node('div', 'create-page'); page.append(node('h1', '', t('rules')),
    selectField(t('chessRules'), 'chess-rules', [['hidden-crown', t('hiddenModeDefault')], ['standard-chess', t('standardMode')]], createRules, value => { createRules = value; render(); }),
    rules(true), node('p', 'rules-extra', t(standardMode() ? 'standardRulesExtra' : 'rulesExtra')),
    button(t('backHome'), () => location.assign('/'), '', false, 'back'));
  app.replaceChildren(page);
}
async function createRoom() {
  if (creating || joining) return;
  creating = true; creationError = null; render();
  try {
    const response = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(createRules === 'standard-chess' ? { ruleset: { id: 'standard-chess', version: 1 } } : {}), ...(createMode === 'computer' ? { computer: { humanColor, difficulty } } : {}) }) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const key = data.code === 'rate_limited' && data.scope?.startsWith('create_') ? `error_${data.scope}` : `error_${data.code ?? 'request'}`;
      creationError = { key, values: { seconds: data.retryAfter ?? response.headers.get('Retry-After') ?? 60 } }; return;
    }
    const data = await response.json();
    if (data.computer) {
      const target = new URL(data.link, location.origin);
      localStorage.setItem(`hidden-crown:room:${data.roomId}:${data.role}`, new URLSearchParams(target.hash.slice(1)).get('t'));
      location.assign(target.href); return;
    }
    inviteLinks = data.links; createdRoomId = data.roomId;
    sessionStorage.setItem(`hidden-crown:created:${data.roomId}`, JSON.stringify(data));
    history.replaceState(null, '', `/create?room=${encodeURIComponent(data.roomId)}`);
    window.scrollTo({ top: 0 });
  } catch { creationError = { key: 'error_request', values: {} }; } finally { creating = false; render(); }
}
function presence() {
  const element = node('div', 'presence');
  for (const color of ['w', 'b']) {
    const item = node('span', 'presence-item'); item.title = t(view.connected[color] ? 'connected' : 'offline');
    item.append(node('span', `dot ${view.connected[color] ? 'online' : ''}`), node('span', '', view.computer?.color === color ? t('computerSide', { color: colorName(color) }) : colorName(color))); element.append(item);
  }
  return element;
}
function turnTiming() {
  const timing = node('div', 'turn-timing'), elapsed = node('div', 'small');
  elapsed.append(node('span', '', t('turnElapsed') + ' '));
  const timer = node('span', 'turn-clock'); timer.id = 'think-timer'; elapsed.append(timer); timing.append(elapsed);
  if (view.role !== 'observer') {
    const sound = button(t(turnSound.enabled ? 'soundOn' : 'soundOff'), () => { turnSound.toggle(); render(); }, 'quiet-button sound-toggle', false, turnSound.enabled ? 'sound' : 'muted');
    sound.setAttribute('aria-pressed', String(turnSound.enabled)); timing.append(sound);
  }
  return timing;
}
function trays(position = view) {
  const panel = node('section', 'panel'); panel.append(node('h2', '', t('captured')));
  if (view.role !== 'observer' && !['playing', 'crown_select'].includes(view.phase)) panel.append(turnTiming());
  const crowns = position.crowns ? Object.values(position.crowns).filter(Boolean) : [position.yourCrown].filter(Boolean);
  const knowledge = interrogationKnowledge(position);
  for (const color of ['w', 'b']) {
    const tray = node('div', 'tray'); tray.append(node('div', 'tray-label', t(color === 'w' ? 'capturedWhite' : 'capturedBlack')));
    const pieces = node('div', 'tray-pieces');
    for (const piece of Object.values(position.pieces).filter(p => p.color === color && p.square === null)) {
      const wrap = node('span', 'captured-piece'); wrap.title = pieceName(piece);
      wrap.append(pieceGraphic(piece));
      if (crowns.includes(piece.id)) wrap.append(crownBadge(color));
      else if (knowledge[piece.id]) wrap.append(interrogationBadge(knowledge[piece.id], color));
      if (knowledge[piece.id]) wrap.title += ` · ${t(`interrogation_${knowledge[piece.id]}`)}`;
      pieces.append(wrap);
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
  const columns = view.role === 'observer' ? ['ply', 'color', 'notation', 'capturedColumn', 'thinkTime'] : ['ply', 'color', 'notation', 'thinkTime'];
  for (const key of columns) header.append(node('th', '', t(key))); head.append(header); table.append(head);
  const body = node('tbody');
  for (const move of view.moves) {
    const label = actionLabel(move, t, view.pieces);
    const row = node('tr'); row.append(node('td', '', String(move.ply)), node('td', '', colorName(move.color)), node('td', 'notation', label));
    if (move.kind === 'interrogation') row.children[2].classList.add('interrogation-notation');
    row.dataset.ply = move.ply;
    if (canReplay(view)) row.children[2].replaceChildren(button(label, () => { seekReplay(move.ply); }, 'move-replay-link'));
    if (move.ply === replayPly) row.classList.add('replay-selected');
    if (view.role === 'observer') row.append(node('td', '', move.captured ?? '—'));
    row.append(node('td', 'move-think-time', t('seconds', { n: thinkingSeconds(move.thinkMs, view.role) })));
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
  const player = view.role === 'w' || view.role === 'b';
  const outcome = result.reason === 'admin' ? t('adminEnd') : result.winner ? player ? t(result.winner === view.role ? 'youWon' : 'youLost') : t('winner', { color: colorName(result.winner) }) : t('draw');
  panel.append(node('p', 'eyebrow', t('ended')), node('h2', '', outcome));
  let explanation;
  if (result.reason === 'crown_captured') {
    const loser = result.winner === 'w' ? 'b' : 'w';
    const target = view.crowns[loser], capture = view.moves.find(move => move.captured === target);
    explanation = player ? t(result.winner === view.role ? 'youCapturedCrown' : 'yourCrownCaptured') : t('crown_captured', { color: colorName(loser), piece: t(view.pieces[target].type) });
    if (capture) explanation += ' ' + t('captureSquare', { square: squareName(capture.to) });
  } else if (result.reason === 'resign') explanation = t('resignReason', { color: colorName(result.winner === 'w' ? 'b' : 'w') });
  else explanation = t(result.reason, { plies: view.ruleset?.options.drawPlyLimit ?? 100 });
  panel.append(node('p', 'result-explanation', explanation));
  if (!standardMode()) panel.append(node('h3', '', t('reveal')));
  const cards = node('div', 'crown-reveal-cards');
  for (const color of player ? [view.role, view.role === 'w' ? 'b' : 'w'] : ['w', 'b']) {
    const id = view.crowns?.[color]; if (!id) continue;
    const piece = view.pieces[id]; const capture = view.moves.find(m => m.captured === id);
    const card = node('div', 'crown-reveal-card'), graphic = node('div', 'revealed-piece');
    graphic.append(pieceGraphic(piece), crownBadge(color));
    const description = node('div', 'crown-reveal-description');
    const owner = player ? t(color === view.role ? 'yourCrownTitle' : 'opponentCrownTitle') + ' · ' + colorName(color) : t('sideCrownTitle', { color: colorName(color) });
    description.append(node('p', 'small crown-owner', owner), node('h3', 'revealed-piece-name', t(piece.type)));
    const origin = view.initialPosition?.pieces[id]?.square;
    const startingSquare = origin === undefined || origin === null ? (id[2] ?? (id[1] === 'K' ? 'e' : 'd')) + (color === 'w' ? '1' : '8') : squareName(origin);
    description.append(node('p', 'small crown-origin', t('startingSquare', { square: startingSquare })));
    const captured = piece.square === null;
    const state = captured ? t(capture ? 'crownCapturedSquare' : 'crownCapturedStatus', { square: capture ? squareName(capture.to) : '' }) : t('crownSurvivedSquare', { square: squareName(piece.square) });
    description.append(node('p', `crown-state ${captured ? 'is-captured' : 'is-surviving'}`, state));
    card.append(graphic, description); cards.append(card);
  }
  panel.append(cards);
  if (view.computer && view.role !== 'observer') panel.append(button(t('playAgain'), () => location.assign(`/create?mode=computer&rules=${view.ruleset.id}`), 'primary', false, 'computer'));
  return panel;
}
function observerPanel() {
  const panel = node('section', 'panel'), stats = node('div', 'observer-stats');
  const phase = node('div'); phase.append(node('span', 'stat-label', t('phase')), node('span', 'stat-value', t(view.phase === 'ended' ? 'endedPhase' : view.phase)));
  stats.append(phase); panel.append(stats, turnTiming());
  for (const color of standardMode() ? [] : ['w', 'b']) {
    const id = view.crowns?.[color];
    panel.append(node('p', 'small', id ? crownDescription(id) : `${colorName(color)} · ${t('crownUnchosen')}`));
    if (view.interrogationsRemaining) panel.append(node('p', 'small', `${colorName(color)} · ${t('interrogationsLeft', { n: view.interrogationsRemaining[color] })}`));
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
  const panel = node('section', 'panel'); panel.append(turnTiming());
  if (view.phase === 'crown_select') {
    panel.append(node('h2', '', t('select')));
    if (view.crownLocked[view.role]) panel.append(node('p', 'small', t('lockedWaiting')));
    else {
      panel.append(node('p', 'small', ruleText('selectHelp')), node('p', 'selection-status', candidate ? t('selectedCrown', { piece: pieceName(view.pieces[candidate]) }) : ''));
      panel.append(button(t('lock'), () => {
        if (candidate) askConfirmation('lockConfirm', () => { lockPending = send({ type: 'select_crown', pieceId: candidate }); render(); });
      }, 'primary', !candidate || lockPending || connection !== 'connected', 'lock'));
    }
  } else if (view.phase === 'playing') {
    if (standardMode()) panel.append(node('p', 'small', t(view.inCheck && view.turn === view.role ? 'checkHelp' : 'standardTurnHelp')));
    if (view.yourCrown) panel.append(node('p', 'small', t('ownCrown', { piece: pieceName(view.pieces[view.yourCrown]) })));
    const actions = node('div', 'actions');
    if (view.interrogationsRemaining) {
      panel.append(node('p', 'small', t('interrogationsLeft', { n: view.interrogationsRemaining[view.role] })));
      const control = button(t(interrogating ? 'cancelInterrogation' : 'interrogate'), () => { interrogating = !interrogating; selected = null; render(); }, interrogating ? 'primary' : '', pending || !(view.interrogationTargets?.length) || connection !== 'connected', 'eye');
      control.setAttribute('aria-pressed', String(interrogating)); control.title = ruleText('interrogateHelp'); actions.append(control);
      if (view.ruleset.version >= 3 && view.pieces[view.role + 'K']?.square === null) panel.append(node('p', 'small', t('kingCapturedInterrogation')));
      if (interrogating) panel.append(node('p', 'small', ruleText('interrogateHelp')));
    }
    if (view.undoEnabled) actions.append(button(t('requestUndo'), () => send({ type: 'request_undo' }), '', !view.canRequestUndo || connection !== 'connected', 'back'));
    if (standardMode() && view.drawClaim && view.turn === view.role) {
      const move = view.drawClaim.move;
      const claim = button(t('claimDraw'), () => send({ type: 'rule_action', action: 'claim_draw', payload: move ? { from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) } : {} }), '', pending || connection !== 'connected', 'draw');
      claim.title = t(view.drawClaim.reason) + (move ? ` · ${squareName(move.from)}–${squareName(move.to)}` : ''); actions.append(claim);
      if (move) panel.append(node('p', 'small', t('claimIntendedMove', { from: squareName(move.from), to: squareName(move.to) })));
    }
    if (!view.computer) actions.append(button(t('offerDraw'), () => send({ type: 'offer_draw' }), '', !!view.drawOffer || !!view.undoRequest || connection !== 'connected', 'draw'));
    actions.append(button(t('resign'), () => askConfirmation('resignConfirm', () => send({ type: 'resign' })), 'danger quiet-button', connection !== 'connected', 'flag'));
    panel.append(actions);
    if (view.undoRequest) {
      const bar = node('div', 'draw-bar'); bar.setAttribute('role', 'status');
      bar.append(node('p', 'small', t(view.undoRequest.color === view.role ? 'undoSent' : 'undoReceived', { count: view.moves.length - view.undoRequest.targetPly })));
      if (view.undoRequest.color !== view.role) {
        const responses = node('div', 'actions');
        responses.append(button(t('accept'), () => send({ type: 'respond_undo', accept: true }), 'primary', connection !== 'connected', 'check'), button(t('decline'), () => send({ type: 'respond_undo', accept: false }), '', connection !== 'connected', 'close')); bar.append(responses);
      }
      panel.append(bar);
    }
    if (view.drawOffer && !view.computer) {
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
  if (view.undoRequest) return t('undoWaiting');
  if (pending) return t('movePending');
  const status = view.role === 'observer' ? t('turn', { color: colorName(view.turn) }) : t(view.turn === view.role ? 'yourTurn' : view.computer ? 'computerThinking' : 'opponentThinking');
  return status + (view.inCheck ? ` · ${t('check')}` : '');
}
function replayLabel() {
  if (replayPly === null) return t('livePosition');
  const move = view.moves[replayPly - 1];
  return t('replayPosition', { n: replayPly, total: view.moves.length }) + (move ? ` · ${actionLabel(move, t, view.pieces)}` : ` · ${t('initialPosition')}`);
}
function seekReplay(ply) {
  if (!canReplay(view)) return;
  replayPly = ply === null ? null : Math.max(0, Math.min(view.moves.length, Number(ply)));
  selected = null; candidate = null; promotionMoves = null;
  document.querySelector('#promotion').close(); document.querySelector('#confirmation').close();
  confirmationAction = null; confirmationKey = null;
  const position = displayedView(), container = app.querySelector('.game-board');
  const enabled = replayPly === null && connection === 'connected' && !pending && !lockPending && !view.undoRequest && view.role !== 'observer' && view.phase === 'playing' && view.turn === view.role;
  renderBoard(container, position, { selected, candidate, enabled, onSquare }); resetBoardMotion(view);
  app.querySelector('.interrogation-legend').hidden = !Object.keys(interrogationKnowledge(position)).length;
  app.querySelector('.replay-label').textContent = replayLabel();
  app.querySelector('#replay-range').value = replayPly ?? view.moves.length;
  app.querySelector('.player-controls')?.toggleAttribute('disabled', replayPly !== null);
  app.querySelector('.capture-trays').replaceChildren(trays(position));
  for (const row of app.querySelectorAll('[data-ply]')) row.classList.toggle('replay-selected', Number(row.dataset.ply) === replayPly);
  followReplayRow(app.querySelector('.move-scroll'), app.querySelector(`[data-ply="${replayPly ?? view.moves.length}"]`));
  for (const button of app.querySelectorAll('[data-replay-direction]')) {
    const step = Number(button.dataset.replayDirection), at = replayPly ?? view.moves.length;
    button.disabled = step < 0 ? at === 0 : at === view.moves.length;
  }
  app.querySelector('.return-live').disabled = replayPly === null;
  updateTimer();
}
function replayControls() {
  const panel = node('section', 'panel replay-panel'); panel.append(node('h2', '', t('replay')));
  const label = node('label', 'small replay-label', replayLabel()); label.htmlFor = 'replay-range';
  const range = node('input'); range.type = 'range'; range.id = 'replay-range'; range.min = '0'; range.max = String(view.moves.length); range.step = '1'; range.value = String(replayPly ?? view.moves.length);
  range.addEventListener('input', () => seekReplay(Number(range.value)));
  const controls = node('div', 'actions replay-actions');
  for (const [step, key, icon] of [[-1, 'previousMove', 'left'], [1, 'nextMove', 'right']]) {
    const at = replayPly ?? view.moves.length;
    const control = button(t(key), () => seekReplay((replayPly ?? view.moves.length) + step), '', step < 0 ? at === 0 : at === view.moves.length, icon);
    control.dataset.replayDirection = step; controls.append(control);
  }
  controls.append(button(t('returnLive'), () => seekReplay(null), 'return-live', replayPly === null, 'refresh'));
  panel.append(label, range, controls); return panel;
}
function renderGame() {
  const scrollPosition = app.querySelector('.move-scroll')?.scrollTop;
  const page = node('div');
  if (view.role === 'observer') page.append(node('div', 'banner observer-banner', t('observerWarning')));
  if (connection !== 'connected') page.append(node('div', 'banner', t(connection)));
  if (view.phase === 'playing') for (const color of ['w', 'b']) if (!view.connected[color]) page.append(node('div', 'banner', t('peerOffline', { color: colorName(color) })));
  const heading = node('div', 'game-heading'), title = node('div');
  title.append(node('div', 'room-label', `${t('room')} ${roomId}`), node('h1', '', statusText()));
  title.append(node('div', 'small game-rules-label', modeName()));
  if (view.computer) title.append(node('div', 'small', `${t('playComputer')} · ${t(`difficulty_${view.computer.difficulty}`)}`));
  heading.append(title, node('div', 'small', view.role === 'observer' ? t('observer') : t('youAre', { color: colorName(view.role) }))); page.append(heading);
  if (view.phase === 'ended' && view.result) page.append(resultPanel());
  const layout = node('div', 'game-layout'), boardColumn = node('div', 'board-column'), boardContainer = node('div', 'game-board');
  const enabled = replayPly === null && connection === 'connected' && !pending && !lockPending && view.role !== 'observer' &&
    ((view.phase === 'playing' && !view.undoRequest && view.turn === view.role) || (view.phase === 'crown_select' && !view.crownLocked[view.role]));
  renderBoard(boardContainer, displayedView(), { selected, candidate, enabled, onSquare, interrogating }); boardColumn.append(boardContainer);
  const status = node('div', 'board-status'); status.append(node('span', 'muted', statusText()), presence()); boardColumn.append(status);
  const legend = node('p', 'small interrogation-legend', t('interrogationMarks'));
  legend.hidden = !Object.keys(interrogationKnowledge(displayedView())).length; boardColumn.append(legend);
  if (view.moves.length && canReplay(view)) boardColumn.append(replayControls());
  const sidebar = node('aside', 'sidebar');
  if (view.role === 'observer') sidebar.append(observerPanel());
  else if (view.phase === 'playing' || view.phase === 'crown_select') {
    const controls = node('fieldset', 'player-controls'); controls.disabled = replayPly !== null; controls.append(playerControls()); sidebar.append(controls);
  }
  const captureTrays = node('div', 'capture-trays'); captureTrays.append(trays(displayedView()));
  sidebar.append(captureTrays, moveTable()); layout.append(boardColumn, sidebar); page.append(layout); app.replaceChildren(page);
  const scroll = app.querySelector('.move-scroll'); if (scroll && scrollPosition !== undefined) scroll.scrollTop = scrollPosition;
  if (replayPly !== null) followReplayRow(scroll, app.querySelector(`[data-ply="${replayPly}"]`));
  if (replayPly === null) animateBoard(boardContainer.querySelector('.board'), view); else resetBoardMotion(view);
  updateTimer();
}
function render() {
  createButton.hidden = Boolean(roomId) || adminWatch;
  createButton.disabled = creating || joining;
  withIcon(createButton, t(creating ? 'creating' : 'create'), 'plus');
  withIcon(document.querySelector('#show-rules'), t('rules'), 'book');
  if (document.querySelector('#rules-dialog').open) renderRulesDialog();
  renderConfirmation();
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; withIcon(languageButton, language === 'en' ? '中文' : 'EN', 'language');
  document.querySelector('#promotion-title').textContent = t('selectPromotion'); withIcon(document.querySelector('#promotion-cancel'), t('cancel'), 'close');
  if (adminWatch && ['adminLoginRequired', 'adminSessionExpired'].includes(connection)) {
    const panel = node('section', 'panel home');
    panel.append(node('h1', '', t('adminAccessTitle')));
    const message = node('p', '', t(connection)); message.setAttribute('role', 'alert'); panel.append(message);
    const login = node('a', 'open-link primary', t('adminLogin'));
    login.href = `/admin?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
    withIcon(login, t('adminLogin'), 'lock'); panel.append(login); app.replaceChildren(panel); return;
  }
  if (createPage) { renderCreate(); return; }
  if (rulesPage) { renderRulesPage(); return; }
  if (!roomId) { renderHome(); return; }
  if (!view) {
    const panel = node('section', 'panel home'); panel.append(node('h1', '', 'Hidden Crown'), node('p', '', t(token || adminWatch ? connection : 'missingToken')));
    if ((token || adminWatch) && connection === 'connectionFailed') panel.append(button(t('retry'), connect, 'primary', false, 'refresh'));
    app.replaceChildren(panel); return;
  }
  renderGame();
}
function onSquare(square) {
  if (replayPly !== null || view.undoRequest) return;
  if (view.phase === 'crown_select') {
    const piece = view.pieces[view.board[square]];
    candidate = piece?.color === view.role && canCrown(piece, view.ruleset.version) ? piece.id : null; render(); return;
  }
  if (interrogating) {
    const targetId = view.board[square];
    if (view.interrogationTargets?.includes(targetId)) { pending = send({ type: 'interrogate', targetId }); interrogating = false; render(); }
    return;
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
  const message = document.querySelector('#notice'); if (noticeKey && !message.hidden) message.textContent = ruleText(noticeKey, noticeValues);
});
function updateTimer() {
  const timer = document.querySelector('#think-timer'); if (!timer || !view) return;
  const start = view.turnStartedAt ?? view.lastMoveAt ?? view.playStartedAt;
  if (view.phase !== 'playing' || start == null || replayPly !== null) timer.textContent = '—';
  else timer.textContent = t('seconds', { n: thinkingSeconds(clockAnchor.serverNow + performance.now() - clockAnchor.receivedAt - start, view.role) });
}
setInterval(updateTimer, 200);
function downloadLog(message) {
  const kind = exportKind; exportKind = null;
  if (!kind) return;
  let content, mime;
  if (kind === 'JSON') { content = JSON.stringify(message, null, 2); mime = 'application/json'; }
  else {
    content = recordsCsv(message.moves);
    mime = 'text/csv;charset=utf-8';
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = node('a'); a.href = url; a.download = `hidden-crown-${roomId}.${kind.toLowerCase()}`; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); render();
}
function requireAdminLogin(expired = false) {
  connectAttempt++; clearTimeout(reconnectTimer); clearInterval(pingTimer);
  if (socket) { socket.onclose = null; socket.onmessage = null; socket.close(); socket = null; }
  view = null; observerLinks = null; exportKind = null; replayPly = null;
  pending = false; lockPending = false; selected = null; candidate = null;
  document.querySelector('#promotion').close(); promotionMoves = null;
  document.querySelector('#confirmation').close(); confirmationAction = null; confirmationKey = null;
  connection = expired ? 'adminSessionExpired' : 'adminLoginRequired'; render();
}
async function connect() {
  if (!token && !adminWatch) return;
  const attempt = ++connectAttempt;
  clearTimeout(reconnectTimer); clearInterval(pingTimer);
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  connection = view ? 'reconnecting' : 'connecting'; render();
  if (adminWatch) {
    try {
      const response = await fetch('/api/admin/session', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (attempt !== connectAttempt) return;
      if (response.status === 401 || response.status === 403) { requireAdminLogin(!!view); return; }
      if (!response.ok) throw new Error('session_unavailable');
    } catch {
      if (attempt !== connectAttempt) return;
      connection = 'connectionFailed'; render(); return;
    }
  }
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
      const oldPly = view?.moves.length, oldPhase = view?.phase, oldUndo = view?.undoRequest;
      if (startsYourTurn(view, message.view)) turnSound.play();
      view = message.view; clockAnchor = { serverNow: view.serverNow, receivedAt: performance.now() };
      if (oldPly !== view.moves.length || oldPhase !== view.phase || JSON.stringify(oldUndo) !== JSON.stringify(view.undoRequest)) { selected = null; interrogating = false; document.querySelector('#promotion').close(); promotionMoves = null; }
      if (oldPly > view.moves.length || !canReplay(view)) replayPly = null;
      const lastAction = view.moves.at(-1);
      if (oldPly !== undefined && oldPly < view.moves.length && lastAction?.kind === 'interrogation' && lastAction.color === view.role) notice('interrogationResult', { piece: pieceName(view.pieces[lastAction.targetId]), answer: t(`interrogation_${lastAction.answer}`) });
      if (oldUndo && !view.undoRequest && view.phase === 'playing') notice(oldPly > view.moves.length ? 'undoAccepted' : 'undoDeclined');
      pending = false; lockPending = false; render();
    } else if (message.type === 'pong') lastPong = Date.now();
    else if (message.type === 'links') { observerLinks = message.links; render(); }
    else if (message.type === 'log') downloadLog(message);
    else if (message.type === 'error') {
      pending = false; lockPending = false; exportKind = null; notice(`error_${message.code}`); render();
    }
  };
  ws.onclose = async event => {
    if (socket !== ws) return;
    clearTimeout(timeout); clearInterval(pingTimer); pending = false; lockPending = false; exportKind = null;
    selected = null; document.querySelector('#promotion').close(); promotionMoves = null;
    document.querySelector('#confirmation').close(); confirmationKey = null; confirmationAction = null;
    if (adminWatch && ['admin_logged_out', 'admin_expired'].includes(event.reason)) { requireAdminLogin(true); return; }
    if (event.code === 4000 || event.code === 4001) { connection = event.reason === 'room_expired' ? 'roomExpired' : event.code === 4000 ? 'replaced' : 'badToken'; render(); return; }
    try {
      if (adminWatch) {
        const auth = await fetch('/api/admin/session', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (socket !== ws) return;
        if (auth.status === 401 || auth.status === 403) { requireAdminLogin(!!view); return; }
      }
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/status`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (socket !== ws) return;
      if (response.status === 404) { connection = 'roomMissing'; render(); return; }
    } catch { /* A network outage uses the normal reconnect path. */ }
    if (socket !== ws) return;
    connection = view ? 'reconnecting' : 'connectionFailed'; render();
    const delay = [1000, 2000, 4000, 8000][attempts++] ?? 10000;
    reconnectTimer = setTimeout(connect, delay);
  };
  ws.onerror = () => { /* onclose owns reconnect and visible feedback. */ };
}
render(); if (roomId && (token || adminWatch)) connect();
if (!roomId && !adminWatch) fetch('/api/rules').then(response => response.ok ? response.json() : null).then(data => {
  computerAvailable = !!data?.computer; capabilitiesLoaded = true; render();
}).catch(() => { capabilitiesLoaded = true; render(); });
