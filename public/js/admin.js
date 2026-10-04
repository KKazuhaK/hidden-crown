import { withIcon } from './icons.js';
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
let loading = false, settings = null, waitingDraft = null, updatedAt = null, saving = false, settingsMessage = '';
const phases = { lobby: '等待玩家', crown_select: '选择王冠', playing: '对弈中', ended: '已结束' };
const errors = { invalid_login: '账号或密码不正确。', admin_required: '请重新登录。', csrf_failed: '登录状态已改变，请刷新后重试。', rate_limited: '操作太频繁，请稍后再试。', room_not_found: '该房间已不存在。', server_busy: '服务器繁忙，请稍后重试。' };
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
const actionIcons = { '刷新列表': 'refresh', '刷新中…': 'refresh', '退出登录': 'enter', JSON: 'download', CSV: 'download', '结束对局': 'stop', '删除': 'trash', '玩家链接': 'copy', '保存': 'check', '上一页': 'left', '下一页': 'right' };
function btn(text, action, className = '', disabled = false) { const node = el('button', text, className); node.type = 'button'; node.disabled = disabled; withIcon(node, text, actionIcons[text]); node.addEventListener('click', action); return node; }
withIcon(document.querySelector('#admin-cancel'), '取消', 'close');
withIcon(document.querySelector('#admin-accept'), '确认', 'check');
withIcon(document.querySelector('#admin-links-close'), '关闭', 'close');
document.querySelector('#admin-links-close').addEventListener('click', () => document.querySelector('#admin-links').close());
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, cache: 'no-store', signal: AbortSignal.timeout(10000), headers: { ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) { if (response.status === 401) csrf = null; throw new Error(errors[value.code] ?? '请求失败，请重试。'); }
  return value;
}
async function playerLinks(id) {
  try {
    const links = await api(`/api/admin/rooms/${id}/links`), content = document.querySelector('#admin-links-content');
    content.replaceChildren(); document.querySelector('#admin-links-title').textContent = `玩家链接 · ${id}`;
    for (const [role, label] of [['white', '白方'], ['black', '黑方']]) {
      const row = el('div', undefined, 'admin-link-row'), input = el('input'); input.readOnly = true;
      input.value = new URL(links[role], location.origin).href; input.setAttribute('aria-label', `${label}进入链接`);
      input.addEventListener('focus', () => input.select());
      const copy = btn('复制', async () => {
        try { await navigator.clipboard.writeText(input.value); withIcon(copy, '已复制', 'check'); }
        catch { input.focus(); input.select(); withIcon(copy, '请手动复制', 'copy'); }
      }); withIcon(copy, '复制', 'copy');
      const open = el('a', '打开', 'open-link'); open.href = input.value; open.target = '_blank'; open.rel = 'noopener noreferrer'; withIcon(open, '打开', 'open');
      row.append(el('strong', label), copy, open, input); content.append(row);
    }
    document.querySelector('#admin-links').showModal();
  } catch (e) { error = e.message; render(); }
}
function settingsPanel() {
  const panel = el('section', undefined, 'panel admin-settings'); panel.append(el('h2', '等待玩家时间上限'));
  const form = el('form'), label = el('label', '创建后等待开局（分钟）'), input = el('input');
  input.id = 'waiting-minutes'; input.type = 'number'; input.min = '1'; input.max = '1440'; input.step = '1'; input.required = true;
  input.value = waitingDraft ?? settings?.waitingMinutes ?? 15; input.disabled = saving; label.htmlFor = input.id;
  input.addEventListener('input', () => { waitingDraft = input.value; });
  const save = btn(saving ? '保存中…' : '保存', () => {}); save.type = 'submit'; save.disabled = saving;
  form.append(label, input, save);
  form.addEventListener('submit', async event => {
    event.preventDefault(); const waitingMinutes = Number(input.value);
    saving = true; settingsMessage = ''; render();
    try {
      settings = await api('/api/admin/settings', 'PUT', { waitingMinutes }); waitingDraft = null;
      settingsMessage = '已保存。超过时限且尚未开局的房间已清理。'; await load();
    } catch (e) { settingsMessage = e.message; }
    finally { saving = false; render(); }
  });
  panel.append(form, el('p', '1–1440 分钟。等待玩家或选择王冠阶段超时会永久清理；对弈中和已结束的记录保留。缩短时限会立即清理已超时的房间。', 'small'));
  if (settingsMessage) { const message = el('p', settingsMessage, 'small'); message.setAttribute('role', 'status'); panel.append(message); }
  return panel;
}
function renderLogin() {
  const panel = el('section', undefined, 'panel admin-login'); panel.append(el('h1', '管理员登录'), el('p', '登录后可查看全部对局和双方王冠，也可结束对局、删除房间。', 'small'));
  const form = el('form'), label = el('label', '管理员密码', 'small'), input = el('input');
  const userLabel = el('label', '管理员账号', 'small'), userInput = el('input');
  userInput.id = 'admin-username'; userInput.name = 'username'; userInput.autocomplete = 'username'; userInput.required = true; userInput.maxLength = 64; userLabel.htmlFor = userInput.id;
  input.type = 'password'; input.id = 'admin-password'; input.name = 'password'; input.autocomplete = 'current-password'; input.required = true; input.maxLength = 256;
  label.htmlFor = input.id;
  const submit = el('button', busy ? '正在登录…' : '登录', 'primary'); submit.type = 'submit'; submit.disabled = busy;
  withIcon(submit, busy ? '正在登录…' : '登录', 'lock');
  form.append(userLabel, userInput, label, input, submit); form.addEventListener('submit', async event => {
    event.preventDefault(); const password = input.value, username = userInput.value; input.value = ''; busy = true; error = ''; render();
    try {
      csrf = (await api('/api/admin/login', 'POST', { username, password })).csrf;
      const destination = returnToWatch(); if (destination) { location.assign(destination); return; }
      await load();
    }
    catch (e) { error = e.message; } finally { busy = false; render(); }
  });
  panel.append(form); if (error) { const message = el('p', error, 'join-error'); message.setAttribute('role', 'alert'); panel.append(message); } root.replaceChildren(panel);
}
function ask(text, action) { confirmAction = action; document.querySelector('#admin-confirm-text').textContent = text; document.querySelector('#admin-confirm').showModal(); }
document.querySelector('#admin-cancel').addEventListener('click', () => { confirmAction = null; document.querySelector('#admin-confirm').close(); });
document.querySelector('#admin-confirm').addEventListener('cancel', () => { confirmAction = null; });
document.querySelector('#admin-accept').addEventListener('click', async () => {
  const action = confirmAction; confirmAction = null; document.querySelector('#admin-confirm').close();
  busy = true; error = ''; render(); try { await action?.(); await load(); } catch (e) { error = e.message; } finally { busy = false; render(); }
});
async function download(id, kind) {
  try {
    const log = await api(`/api/admin/rooms/${id}/log`);
    const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const content = kind === 'JSON' ? JSON.stringify(log, null, 2) : ['ply,color,notation,piece_id,captured_id,think_ms,timestamp_iso', ...log.moves.map(move => [move.ply, move.color, move.notation, move.pieceId, move.captured, move.thinkMs, new Date(move.at).toISOString()].map(quote).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob([content], { type: kind === 'JSON' ? 'application/json' : 'text/csv;charset=utf-8' }));
    const link = el('a'); link.href = url; link.download = `hidden-crown-${id}.${kind.toLowerCase()}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { error = e.message; render(); }
}
function render() {
  if (!csrf) { document.querySelector('#admin-links').close(); document.querySelector('#admin-links-content').replaceChildren(); return renderLogin(); }
  const oldScroll = root.querySelector('.admin-table-scroll'), scrollLeft = oldScroll?.scrollLeft ?? 0, scrollTop = oldScroll?.scrollTop ?? 0;
  const focusId = root.contains(document.activeElement) ? document.activeElement.id : null;
  const top = el('div', undefined, 'game-heading'); top.append(el('h1', '全部对局'));
  const actions = el('div', undefined, 'actions');
  const refresh = btn(loading ? '刷新中…' : '刷新列表', () => load(), loading ? 'is-refreshing' : '', busy || loading); refresh.id = 'admin-refresh';
  actions.append(refresh, btn('退出登录', async () => { try { await api('/api/admin/logout', 'POST'); csrf = null; data = null; render(); } catch (e) { error = e.message; render(); } }, '', busy)); top.append(actions);
  const warning = el('div', '上帝视角会显示双方王冠，请勿与玩家分享屏幕。', 'banner observer-banner');
  const panel = el('section', undefined, 'panel');
  const status = el('p', `共 ${data?.total ?? 0} 个房间 · 第 ${page} 页${loading ? ' · 正在刷新…' : updatedAt ? ` · 更新于 ${updatedAt.toLocaleTimeString()}` : ''}`, 'small'); status.setAttribute('role', 'status'); panel.append(status);
  if (error) { const message = el('p', error, 'join-error'); message.setAttribute('role', 'alert'); panel.append(message); }
  const scroll = el('div', undefined, 'admin-table-scroll'), table = el('table'), head = el('thead'), row = el('tr');
  for (const text of ['房间号', '创建时间', '阶段', '半回合', '在线状态', '操作']) row.append(el('th', text)); head.append(row); table.append(head);
  const body = el('tbody');
  for (const room of data?.rooms ?? []) {
    const phase = el('td', phases[room.phase]); if (room.waitingExpiresAt) phase.append(el('div', `${new Date(room.waitingExpiresAt).toLocaleTimeString()} 超时清理`, 'small'));
    const row = el('tr'); row.append(el('td', room.id, 'notation'), el('td', new Date(room.created_at).toLocaleString()), phase, el('td', String(room.ply)), el('td', `白 ${room.connected.w ? '在线' : '离线'} / 黑 ${room.connected.b ? '在线' : '离线'}`));
    const cell = el('td'), actions = el('div', undefined, 'actions');
    const watch = el('a', '上帝视角', 'open-link'); watch.href = `/admin/watch?room=${room.id}`; watch.target = '_blank'; watch.rel = 'noopener noreferrer'; actions.append(watch);
    withIcon(watch, '上帝视角', 'eye');
    actions.append(btn('玩家链接', () => playerLinks(room.id), '', busy));
    actions.append(btn('JSON', () => download(room.id, 'JSON'), '', busy), btn('CSV', () => download(room.id, 'CSV'), '', busy));
    actions.append(btn('结束对局', () => ask(`确认结束 ${room.id}？玩家将看到“管理员已结束对局”，对局和日志会保留。`, () => api(`/api/admin/rooms/${room.id}/end`, 'POST')), 'danger', busy || room.phase === 'ended'));
    actions.append(btn('删除', () => ask(`永久删除 ${room.id} 及其全部对局记录和日志？所有连接会断开，无法恢复。需要保留的记录请先导出。`, () => api(`/api/admin/rooms/${room.id}`, 'DELETE')), 'danger', busy));
    cell.append(actions); row.append(cell); body.append(row);
  }
  table.append(body); scroll.append(table); panel.append(scroll);
  if (!data?.rooms.length) panel.append(el('p', '暂无对局。', 'empty-moves'));
  const pages = el('div', undefined, 'actions admin-pages'); pages.append(btn('上一页', () => { page--; load(); }, '', page <= 1 || busy || loading), btn('下一页', () => { page++; load(); }, '', page * 50 >= (data?.total ?? 0) || busy || loading)); panel.append(pages);
  root.replaceChildren(top, warning, settingsPanel(), panel);
  scroll.scrollLeft = scrollLeft; scroll.scrollTop = scrollTop;
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
}
async function load(silent = false) {
  if (loading) return;
  loading = true; if (!silent) render();
  try {
    const [rooms, config] = await Promise.all([api(`/api/admin/rooms?page=${page}`), api('/api/admin/settings')]);
    const lastPage = Math.max(1, Math.ceil(rooms.total / rooms.pageSize));
    if (page > lastPage) { page = lastPage; data = await api(`/api/admin/rooms?page=${page}`); } else data = rooms;
    settings = config; updatedAt = new Date(); error = '';
  } catch (e) { error = e.name === 'TimeoutError' ? '请求超时，请重试。' : e.message; }
  finally { loading = false; render(); }
}
try { csrf = (await api('/api/admin/session')).csrf; await load(); } catch { render(); }
setInterval(() => { if (csrf && !busy && !loading && !saving && !document.hidden && !document.querySelector('#admin-confirm').open && !document.querySelector('#admin-links').open && document.activeElement?.id !== 'waiting-minutes') load(true); }, 10000);
