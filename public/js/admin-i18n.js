import { language } from './i18n.js';

const strings = {
  en: {
    computer: 'Computer', easy: 'Easy', medium: 'Medium', hard: 'Hard',
    networkTitle: 'Reverse proxy diagnostics', networkAddresses: 'Proxy peer: {peer} · Client address: {client}',
    networkAccepted: 'The trusted proxy supplied a valid client address. Check that Nginx replaces X-Forwarded-For with the actual visitor address.',
    networkUntrusted: 'The forwarding header is ignored. If {peer} is your Nginx peer, set TRUSTED_PROXIES={peer} and recreate the container; users currently share this peer’s limits.',
    networkInvalid: 'The trusted proxy supplied an invalid address or a list. Configure Nginx to replace X-Forwarded-For with a single visitor address.',
    networkMissing: 'No forwarding header received. Direct connections use their peer address; if using Nginx, configure it to pass the actual visitor address.',
    admin: 'Admin', pageTitle: 'Hidden Crown · Admin', loginTitle: 'Administrator login', loginHelp: 'View all games and both crowns, end games, or delete their records.',
    username: 'Username', password: 'Password', login: 'Log in', loggingIn: 'Logging in…', logout: 'Log out', allGames: 'All games',
    refresh: 'Refresh list', refreshing: 'Refreshing…', confirmTitle: 'Confirm action', cancel: 'Cancel', confirm: 'Confirm', close: 'Close',
    playerLinks: 'Player links', playerLinksTitle: 'Player links · {id}', playerLinksHelp: 'Share each private link only with its player. Opening a link in another tab replaces that player’s current connection.',
    whiteLink: 'White player link', blackLink: 'Black player link', white: 'White', black: 'Black', copy: 'Copy', copied: 'Copied', copyManually: 'Copy manually', open: 'Open',
    waitingTitle: 'Time limit for starting a game', waitingLabel: 'Wait after creation (minutes)', save: 'Save', saving: 'Saving…',
    waitingHelp: '1–1440 minutes. Waiting rooms and crown selection expire; games that have started or finished are kept. Reducing the limit immediately removes overdue rooms.',
    settingsSaved: 'Saved. Overdue rooms that have not started have been removed.',
    godWarning: 'God view reveals both crowns. Do not share this screen with players.', godView: 'God view',
    listStatus: 'Rooms: {total} · Page {page}', updating: 'Updating…', updatedAt: 'Updated at {time}',
    roomNumber: 'Room number', createdAt: 'Created', phase: 'Phase', ply: 'Ply', presence: 'Players online', actions: 'Actions',
    lobby: 'Waiting for players', crown_select: 'Choosing crowns', playing: 'Playing', ended: 'Ended', expiresAt: 'Expires at {time}',
    online: 'online', offline: 'offline', presenceText: 'White {white} / Black {black}',
    JSON: 'JSON', CSV: 'CSV', endGame: 'End game', delete: 'Delete', noGames: 'No games yet.', previous: 'Previous', next: 'Next',
    endConfirm: 'End {id}? Players will see “Ended by administrator”. Game records and logs will be kept.',
    deleteConfirm: 'Permanently delete {id} and all its game records and logs? All connections will close. This cannot be undone. Export any records you need first.',
    invalidLogin: 'Incorrect username or password.', loginRequired: 'Please log in again.', csrfFailed: 'Your login session has changed. Refresh and try again.',
    rateLimited: 'Too many requests. Please try again later.', roomMissing: 'This room no longer exists.', serverBusy: 'The server is busy. Please try again.', requestFailed: 'The request failed. Please try again.', timeout: 'The request timed out. Please try again.'
  },
  zh: {
    computer: '人机', easy: '简单', medium: '中等', hard: '困难',
    networkTitle: '反向代理诊断', networkAddresses: '反代来源：{peer} · 客户端地址：{client}',
    networkAccepted: '已接受受信反代传递的客户端地址。请确认 Nginx 覆盖 X-Forwarded-For，传递真实访客地址。',
    networkUntrusted: '转发头被忽略。如果 {peer} 是你的 Nginx 来源，请设置 TRUSTED_PROXIES={peer} 并重建容器；当前访客会共用该来源的限额。',
    networkInvalid: '受信反代传递的地址无效或包含多个地址。请让 Nginx 覆盖 X-Forwarded-For，仅传递一个真实访客地址。',
    networkMissing: '没有收到转发头。直连时使用连接来源地址；如果经过 Nginx，请配置其传递真实访客地址。',
    admin: '管理员', pageTitle: 'Hidden Crown · 管理员', loginTitle: '管理员登录', loginHelp: '登录后可查看全部对局和双方王冠，也可结束对局、删除记录。',
    username: '管理员账号', password: '管理员密码', login: '登录', loggingIn: '正在登录…', logout: '退出登录', allGames: '全部对局',
    refresh: '刷新列表', refreshing: '刷新中…', confirmTitle: '确认操作', cancel: '取消', confirm: '确认', close: '关闭',
    playerLinks: '玩家链接', playerLinksTitle: '玩家链接 · {id}', playerLinksHelp: '专属链接可恢复该玩家席位，请仅发给对应玩家。在其他标签页打开会替换该玩家当前连接。',
    whiteLink: '白方进入链接', blackLink: '黑方进入链接', white: '白方', black: '黑方', copy: '复制', copied: '已复制', copyManually: '请手动复制', open: '打开',
    waitingTitle: '等待玩家时间上限', waitingLabel: '创建后等待开局（分钟）', save: '保存', saving: '保存中…',
    waitingHelp: '1–1440 分钟。等待玩家或选择王冠阶段超时会永久清理；对弈中和已结束的记录保留。缩短时限会立即清理已超时的房间。',
    settingsSaved: '已保存。超过时限且尚未开局的房间已清理。',
    godWarning: '上帝视角会显示双方王冠，请勿与玩家分享屏幕。', godView: '上帝视角',
    listStatus: '共 {total} 个房间 · 第 {page} 页', updating: '正在刷新…', updatedAt: '更新于 {time}',
    roomNumber: '房间号', createdAt: '创建时间', phase: '阶段', ply: '半回合', presence: '在线状态', actions: '操作',
    lobby: '等待玩家', crown_select: '选择王冠', playing: '对弈中', ended: '已结束', expiresAt: '{time} 超时清理',
    online: '在线', offline: '离线', presenceText: '白 {white} / 黑 {black}',
    JSON: 'JSON', CSV: 'CSV', endGame: '结束对局', delete: '删除', noGames: '暂无对局。', previous: '上一页', next: '下一页',
    endConfirm: '确认结束 {id}？玩家将看到“管理员已结束对局”，对局和日志会保留。',
    deleteConfirm: '永久删除 {id} 及其全部对局记录和日志？所有连接会断开，无法恢复。需要保留的记录请先导出。',
    invalidLogin: '账号或密码不正确。', loginRequired: '请重新登录。', csrfFailed: '登录状态已改变，请刷新后重试。',
    rateLimited: '操作太频繁，请稍后再试。', roomMissing: '该房间已不存在。', serverBusy: '服务器繁忙，请稍后重试。', requestFailed: '请求失败，请重试。', timeout: '请求超时，请重试。'
  }
};

export function adminT(key, values = {}) {
  return (strings[language][key] ?? strings.en.requestFailed).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
}
