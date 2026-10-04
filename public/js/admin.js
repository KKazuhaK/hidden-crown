import { withIcon } from './icons.js';
const root = document.querySelector('#admin-app');
let csrf = null, page = 1, data = null, error = '', busy = false, confirmAction = null;
const phases = { lobby: '等待玩家', crown_select: '选择王冠', playing: '对弈中', ended: '已结束' };
const errors = { invalid_login: '账号或密码不正确。', admin_required: '请重新登录。', csrf_failed: '登录状态已改变，请刷新后重试。', rate_limited: '操作太频繁，请稍后再试。', room_not_found: '该房间已不存在。', server_busy: '服务器繁忙，请稍后重试。' };
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
const actionIcons = { '刷新列表': 'refresh', '退出登录': 'enter', JSON: 'download', CSV: 'download', '结束对局': 'stop', '删除房间': 'trash', '上一页': 'left', '下一页': 'right' };
function btn(text, action, className = '', disabled = false) { const node = el('button', text, className); node.type = 'button'; node.disabled = disabled; withIcon(node, text, actionIcons[text]); node.addEventListener('click', action); return node; }
withIcon(document.querySelector('#admin-cancel'), '取消', 'close');
withIcon(document.querySelector('#admin-accept'), '确认', 'check');
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) { if (response.status === 401) csrf = null; throw new Error(errors[value.code] ?? '请求失败，请重试。'); }
  return value;
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
    try { csrf = (await api('/api/admin/login', 'POST', { username, password })).csrf; await load(); }
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
  if (!csrf) return renderLogin();
  const top = el('div', undefined, 'game-heading'); top.append(el('h1', '全部对局'));
  const actions = el('div', undefined, 'actions');
  actions.append(btn('刷新列表', () => load(), '', busy), btn('退出登录', async () => { try { await api('/api/admin/logout', 'POST'); csrf = null; data = null; render(); } catch (e) { error = e.message; render(); } }, '', busy)); top.append(actions);
  const warning = el('div', '上帝视角会显示双方王冠，请勿与玩家分享屏幕。', 'banner observer-banner');
  const panel = el('section', undefined, 'panel'); panel.append(el('p', `共 ${data?.total ?? 0} 个房间 · 第 ${page} 页`, 'small'));
  if (error) { const message = el('p', error, 'join-error'); message.setAttribute('role', 'alert'); panel.append(message); }
  const scroll = el('div', undefined, 'admin-table-scroll'), table = el('table'), head = el('thead'), row = el('tr');
  for (const text of ['房间号', '创建时间', '阶段', '半回合', '在线状态', '操作']) row.append(el('th', text)); head.append(row); table.append(head);
  const body = el('tbody');
  for (const room of data?.rooms ?? []) {
    const row = el('tr'); row.append(el('td', room.id, 'notation'), el('td', new Date(room.created_at).toLocaleString()), el('td', phases[room.phase]), el('td', String(room.ply)), el('td', `白 ${room.connected.w ? '在线' : '离线'} / 黑 ${room.connected.b ? '在线' : '离线'}`));
    const cell = el('td'), actions = el('div', undefined, 'actions');
    const watch = el('a', '上帝视角', 'open-link'); watch.href = `/admin/watch?room=${room.id}`; watch.target = '_blank'; watch.rel = 'noopener noreferrer'; actions.append(watch);
    withIcon(watch, '上帝视角', 'eye');
    actions.append(btn('JSON', () => download(room.id, 'JSON'), '', busy), btn('CSV', () => download(room.id, 'CSV'), '', busy));
    actions.append(btn('结束对局', () => ask(`确认结束 ${room.id}？玩家将看到“管理员已结束对局”，对局和日志会保留。`, () => api(`/api/admin/rooms/${room.id}/end`, 'POST')), 'danger', busy || room.phase === 'ended'));
    actions.append(btn('删除房间', () => ask(`永久删除 ${room.id} 及其全部对局记录和日志？所有连接会断开，无法恢复。需要保留的记录请先导出。`, () => api(`/api/admin/rooms/${room.id}`, 'DELETE')), 'danger', busy));
    cell.append(actions); row.append(cell); body.append(row);
  }
  table.append(body); scroll.append(table); panel.append(scroll);
  if (!data?.rooms.length) panel.append(el('p', '暂无对局。', 'empty-moves'));
  const pages = el('div', undefined, 'actions admin-pages'); pages.append(btn('上一页', () => { page--; load(); }, '', page <= 1 || busy), btn('下一页', () => { page++; load(); }, '', page * 50 >= (data?.total ?? 0) || busy)); panel.append(pages);
  root.replaceChildren(top, warning, panel);
}
async function load() {
  try { data = await api(`/api/admin/rooms?page=${page}`); error = ''; }
  catch (e) { error = e.message; } render();
}
try { csrf = (await api('/api/admin/session')).csrf; await load(); } catch { render(); }
setInterval(() => { if (csrf && !busy && !document.hidden && !document.querySelector('#admin-confirm').open) load(); }, 10000);
