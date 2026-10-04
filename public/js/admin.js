import { withIcon } from './icons.js';
import { recordsCsv } from './game-records.js';
import { language, toggleLanguage } from './i18n.js';
import { adminT as t } from './admin-i18n.js';
const languageButton = document.querySelector('#language');
languageButton.addEventListener('click', () => { toggleLanguage(); render(); });
const root = document.querySelector('#admin-app');
function returnToWatch() {
  const requested = new URLSearchParams(location.search).get('returnTo'); if (!requested) return null;
  try {
    const target = new URL(requested, location.origin), room = target.searchParams.get('room');
    if (target.origin === location.origin && target.pathname === '/admin/watch' && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(room ?? '')) return `/admin/watch?room=${room}`;
  } catch { /* Untrusted return URLs never leave the local application. */ }
  return null;
}
let csrf = null, page = 1, data = null, error = '', busy = false, confirmAction = null;
let loading = false, settings = null, network = null, waitingDraft = null, updatedAt = null, saving = false, settingsMessage = '';

const errors = { invalid_login: 'invalidLogin', admin_required: 'loginRequired', csrf_failed: 'csrfFailed', rate_limited: 'rateLimited', room_not_found: 'roomMissing', server_busy: 'serverBusy' };
function displayMessage(value) { return value?.translationKey ? t(value.translationKey) : value?.message ?? String(value || ''); }
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
const actionIcons = { refresh: 'refresh', refreshing: 'refresh', logout: 'enter', JSON: 'download', CSV: 'download', endGame: 'stop', delete: 'trash', playerLinks: 'copy', save: 'check', previous: 'left', next: 'right' };
function btn(key, action, className = '', disabled = false) { const text = t(key), node = el('button', text, className); node.type = 'button'; node.disabled = disabled; withIcon(node, text, actionIcons[key]); node.addEventListener('click', action); return node; }
withIcon(document.querySelector('#admin-cancel'), t('cancel'), 'close');
withIcon(document.querySelector('#admin-accept'), t('confirm'), 'check');
withIcon(document.querySelector('#admin-links-close'), t('close'), 'close');
document.querySelector('#admin-links-close').addEventListener('click', () => document.querySelector('#admin-links').close());
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, cache: 'no-store', signal: AbortSignal.timeout(10000), headers: { ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) { if (response.status === 401) csrf = null; const failure = new Error(); failure.translationKey = errors[value.code] ?? 'requestFailed'; throw failure; }
  return value;
}
async function playerLinks(id) {
  try {
    const links = await api(`/api/admin/rooms/${id}/links`), content = document.querySelector('#admin-links-content');
    content.replaceChildren(); document.querySelector('#admin-links-title').textContent = t('playerLinksTitle', { id });
    for (const [role, label] of [['white', t('white')], ['black', t('black')]]) {
      if (!links[role]) continue;
      const row = el('div', undefined, 'admin-link-row'), input = el('input'); input.readOnly = true;
      input.value = new URL(links[role], location.origin).href; input.setAttribute('aria-label', t(role === 'white' ? 'whiteLink' : 'blackLink'));
      input.addEventListener('focus', () => input.select());
      const copy = btn('copy', async () => {
        try { await navigator.clipboard.writeText(input.value); withIcon(copy, t('copied'), 'check'); }
        catch { input.focus(); input.select(); withIcon(copy, t('copyManually'), 'copy'); }
      }); withIcon(copy, t('copy'), 'copy');
      const open = el('a', t('open'), 'open-link'); open.href = input.value; open.target = '_blank'; open.rel = 'noopener noreferrer'; withIcon(open, t('open'), 'open');
      row.append(el('strong', label), copy, open, input); content.append(row);
    }
    document.querySelector('#admin-links').showModal();
  } catch (e) { error = e; render(); }
}
function settingsPanel() {
  const panel = el('section', undefined, 'panel admin-settings'); panel.append(el('h2', t('waitingTitle')));
  const form = el('form'), label = el('label', t('waitingLabel')), input = el('input');
  input.id = 'waiting-minutes'; input.type = 'number'; input.min = '1'; input.max = '1440'; input.step = '1'; input.required = true;
  input.value = waitingDraft ?? settings?.waitingMinutes ?? 15; input.disabled = saving; label.htmlFor = input.id;
  input.addEventListener('input', () => { waitingDraft = input.value; });
  const save = btn(saving ? 'saving' : 'save', () => {}); save.type = 'submit'; save.disabled = saving;
  form.append(label, input, save);
  form.addEventListener('submit', async event => {
    event.preventDefault(); const waitingMinutes = Number(input.value);
    saving = true; settingsMessage = ''; render();
    try {
      settings = await api('/api/admin/settings', 'PUT', { waitingMinutes }); waitingDraft = null;
      settingsMessage = { translationKey: 'settingsSaved' }; await load();
    } catch (e) { settingsMessage = e; }
    finally { saving = false; render(); }
  });
  panel.append(form, el('p', t('waitingHelp'), 'small'));
  if (settingsMessage) { const message = el('p', displayMessage(settingsMessage), 'small'); message.setAttribute('role', 'status'); panel.append(message); }
  return panel;
}
function networkPanel() {
  const panel = el('section', undefined, 'panel'); panel.append(el('h2', t('networkTitle')));
  if (network) {
    panel.append(el('p', t('networkAddresses', { peer: network.peerIp, client: network.clientIp }), 'small'));
    const key = network.forwardedAccepted ? 'networkAccepted' : network.forwardedHeaderPresent ? network.proxyTrusted ? 'networkInvalid' : 'networkUntrusted' : 'networkMissing';
    panel.append(el('p', t(key, { peer: network.peerIp }), 'small'));
  }
  return panel;
}
function renderLogin() {
  const panel = el('section', undefined, 'panel admin-login'); panel.append(el('h1', t('loginTitle')), el('p', t('loginHelp'), 'small'));
  const form = el('form'), label = el('label', t('password'), 'small'), input = el('input');
  const userLabel = el('label', t('username'), 'small'), userInput = el('input');
  userInput.id = 'admin-username'; userInput.name = 'username'; userInput.autocomplete = 'username'; userInput.required = true; userInput.maxLength = 64; userLabel.htmlFor = userInput.id;
  input.type = 'password'; input.id = 'admin-password'; input.name = 'password'; input.autocomplete = 'current-password'; input.required = true; input.maxLength = 256;
  label.htmlFor = input.id;
  const submit = el('button', busy ? t('loggingIn') : t('login'), 'primary'); submit.type = 'submit'; submit.disabled = busy;
  withIcon(submit, busy ? t('loggingIn') : t('login'), 'lock');
  form.append(userLabel, userInput, label, input, submit); form.addEventListener('submit', async event => {
    event.preventDefault(); const password = input.value, username = userInput.value; input.value = ''; busy = true; error = ''; render();
    try {
      csrf = (await api('/api/admin/login', 'POST', { username, password })).csrf;
      const destination = returnToWatch(); if (destination) { location.assign(destination); return; }
      await load();
    }
    catch (e) { error = e; } finally { busy = false; render(); }
  });
  panel.append(form); if (error) { const message = el('p', displayMessage(error), 'join-error'); message.setAttribute('role', 'alert'); panel.append(message); } root.replaceChildren(panel);
}
function ask(text, action) { confirmAction = action; document.querySelector('#admin-confirm-text').textContent = text; document.querySelector('#admin-confirm').showModal(); }
document.querySelector('#admin-cancel').addEventListener('click', () => { confirmAction = null; document.querySelector('#admin-confirm').close(); });
document.querySelector('#admin-confirm').addEventListener('cancel', () => { confirmAction = null; });
document.querySelector('#admin-accept').addEventListener('click', async () => {
  const action = confirmAction; confirmAction = null; document.querySelector('#admin-confirm').close();
  busy = true; error = ''; render(); try { await action?.(); await load(); } catch (e) { error = e; } finally { busy = false; render(); }
});
async function download(id, kind) {
  try {
    const log = await api(`/api/admin/rooms/${id}/log`);
    const content = kind === 'JSON' ? JSON.stringify(log, null, 2) : recordsCsv(log.moves);
    const url = URL.createObjectURL(new Blob([content], { type: kind === 'JSON' ? 'application/json' : 'text/csv;charset=utf-8' }));
    const link = el('a'); link.href = url; link.download = `hidden-crown-${id}.${kind.toLowerCase()}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { error = e; render(); }
}
function render() {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.title = t('pageTitle');
  document.querySelector('#admin-label').textContent = t('admin');
  withIcon(languageButton, language === 'en' ? '中文' : 'EN', 'language');
  document.querySelector('#admin-confirm-title').textContent = t('confirmTitle');
  document.querySelector('#admin-links-title').textContent = t('playerLinks');
  document.querySelector('#admin-links-help').textContent = t('playerLinksHelp');
  withIcon(document.querySelector('#admin-cancel'), t('cancel'), 'close');
  withIcon(document.querySelector('#admin-accept'), t('confirm'), 'check');
  withIcon(document.querySelector('#admin-links-close'), t('close'), 'close');
  if (!csrf) { document.querySelector('#admin-links').close(); document.querySelector('#admin-links-content').replaceChildren(); return renderLogin(); }
  const oldScroll = root.querySelector('.admin-table-scroll'), scrollLeft = oldScroll?.scrollLeft ?? 0, scrollTop = oldScroll?.scrollTop ?? 0;
  const focusId = root.contains(document.activeElement) ? document.activeElement.id : null;
  const top = el('div', undefined, 'game-heading'); top.append(el('h1', t('allGames')));
  const actions = el('div', undefined, 'actions');
  const refresh = btn(loading ? 'refreshing' : 'refresh', () => load(), `admin-refresh${loading ? ' is-refreshing' : ''}`, busy || loading); refresh.id = 'admin-refresh';
  actions.append(refresh, btn('logout', async () => { try { await api('/api/admin/logout', 'POST'); csrf = null; data = null; render(); } catch (e) { error = e; render(); } }, '', busy)); top.append(actions);
  const warning = el('div', t('godWarning'), 'banner observer-banner');
  const panel = el('section', undefined, 'panel');
  const status = el('p', t('listStatus', { total: data?.total ?? 0, page }) + (loading ? ` · ${t('updating')}` : updatedAt ? ` · ${t('updatedAt', { time: updatedAt.toLocaleTimeString(language === 'en' ? 'en-US' : 'zh-CN') })}` : ''), 'small'); status.setAttribute('role', 'status'); panel.append(status);
  if (error) { const message = el('p', displayMessage(error), 'join-error'); message.setAttribute('role', 'alert'); panel.append(message); }
  const scroll = el('div', undefined, 'admin-table-scroll'), table = el('table'), head = el('thead'), row = el('tr');
  for (const text of ['roomNumber', 'createdAt', 'phase', 'ply', 'presence', 'actions']) row.append(el('th', t(text))); head.append(row); table.append(head);
  const body = el('tbody');
  for (const room of data?.rooms ?? []) {
    const roomCell = el('td', room.id, 'notation');
    if (room.computer_color) roomCell.append(el('div', `${t('computer')} · ${t(room.computer_difficulty)}`, 'small'));
    const phase = el('td', t(room.phase)); if (room.waitingExpiresAt) phase.append(el('div', t('expiresAt', { time: new Date(room.waitingExpiresAt).toLocaleTimeString(language === 'en' ? 'en-US' : 'zh-CN') }), 'small'));
    const row = el('tr'); row.append(roomCell, el('td', new Date(room.created_at).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')), phase, el('td', String(room.ply)), el('td', t('presenceText', { white: t(room.connected.w ? 'online' : 'offline'), black: t(room.connected.b ? 'online' : 'offline') })));
    const cell = el('td'), actions = el('div', undefined, 'actions');
    const watch = el('a', t('godView'), 'open-link'); watch.href = `/admin/watch?room=${room.id}`; watch.target = '_blank'; watch.rel = 'noopener noreferrer'; actions.append(watch);
    withIcon(watch, t('godView'), 'eye');
    actions.append(btn('playerLinks', () => playerLinks(room.id), '', busy));
    actions.append(btn('JSON', () => download(room.id, 'JSON'), '', busy), btn('CSV', () => download(room.id, 'CSV'), '', busy));
    actions.append(btn('endGame', () => ask(t('endConfirm', { id: room.id }), () => api(`/api/admin/rooms/${room.id}/end`, 'POST')), 'danger', busy || room.phase === 'ended'));
    actions.append(btn('delete', () => ask(t('deleteConfirm', { id: room.id }), () => api(`/api/admin/rooms/${room.id}`, 'DELETE')), 'danger', busy));
    cell.append(actions); row.append(cell); body.append(row);
  }
  table.append(body); scroll.append(table); panel.append(scroll);
  if (!data?.rooms.length) panel.append(el('p', t('noGames'), 'empty-moves'));
  const pages = el('div', undefined, 'actions admin-pages'); pages.append(btn('previous', () => { page--; load(); }, '', page <= 1 || busy || loading), btn('next', () => { page++; load(); }, '', page * 50 >= (data?.total ?? 0) || busy || loading)); panel.append(pages);
  root.replaceChildren(top, warning, settingsPanel(), networkPanel(), panel);
  scroll.scrollLeft = scrollLeft; scroll.scrollTop = scrollTop;
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
}
async function load(silent = false) {
  if (loading) return;
  loading = true; if (!silent) render();
  try {
    const [rooms, config, addresses] = await Promise.all([api(`/api/admin/rooms?page=${page}`), api('/api/admin/settings'), api('/api/admin/network')]);
    const lastPage = Math.max(1, Math.ceil(rooms.total / rooms.pageSize));
    if (page > lastPage) { page = lastPage; data = await api(`/api/admin/rooms?page=${page}`); } else data = rooms;
    settings = config; network = addresses; updatedAt = new Date(); error = '';
  } catch (e) { error = e.name === 'TimeoutError' ? { translationKey: 'timeout' } : e; }
  finally { loading = false; render(); }
}
try { csrf = (await api('/api/admin/session')).csrf; await load(); } catch { render(); }
setInterval(() => { if (csrf && !busy && !loading && !saving && !document.hidden && !document.querySelector('#admin-confirm').open && !document.querySelector('#admin-links').open && document.activeElement?.id !== 'waiting-minutes') load(true); }, 10000);
