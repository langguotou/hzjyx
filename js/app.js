/**
 * 临时邮箱 - 基于 mail.tm API (https://api.mail.tm)
 * 特点：RESTful API、支持自定义前缀、多邮箱池、自动轮询
 * 
 * 功能：
 * - 随机/自定义前缀生成邮箱
 * - 邮箱池（保存、切换、删除）
 * - 每5秒自动轮询收信
 * - 邮件详情查看（支持HTML）
 * - 发邮件（本地模拟演示，因免费服务发信需验证码）
 * - 全屏模式
 */

const API_BASE = 'https://api.mail.tm';

// ============ 状态 ============
let account = null;      // { address, password }
let token = null;
let pollingTimer = null;

// 邮箱池 Key
const POOL_KEY = 'tempmail_mailtm_v2';

// ============ DOM ============
const emailText   = document.getElementById('emailText');
const copyBtn     = document.getElementById('copyBtn');
const saveBtn     = document.getElementById('saveBtn');
const prefixInput = document.getElementById('prefixInput');
const generateBtn = document.getElementById('generateBtn');
const errorMsg    = document.getElementById('errorMsg');
const mailList    = document.getElementById('mailList');
const refreshBtn  = document.getElementById('refreshBtn');
const modalOverlay= document.getElementById('modalOverlay');
const modalClose  = document.getElementById('modalClose');

// 侧边栏
const menuBtn = document.getElementById('menuBtn');
const sidebar = document.getElementById('sidebar');
const sidebarClose = document.getElementById('sidebarClose');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const mailboxList = document.getElementById('mailboxList');
const newMailBtn = document.getElementById('newMailBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');

// 公告按钮
const adBtn = document.getElementById('adBtn');
const composeOverlay = document.getElementById('composeOverlay');
const composeClose = document.getElementById('composeClose');

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindEvents();
  setupFullscreen();
  
  // 尝试恢复上次邮箱
  const saved = localStorage.getItem(POOL_KEY + '_last');
  if (saved) {
    try {
      const acc = JSON.parse(saved);
      await restoreAccount(acc);
    } catch(e) {
      console.warn('恢复失败', e);
    }
  }
  
  loadMailboxList();
}

function bindEvents() {
  // 侧边栏
  menuBtn.addEventListener('click', openSidebar);
  sidebarClose.addEventListener('click', closeSidebar);
  sidebarOverlay.addEventListener('click', closeSidebar);

  // 新建邮箱
  newMailBtn.addEventListener('click', () => {
    closeSidebar();
    prefixInput.value = '';
    generateEmail(false);
  });

  // 自定义前缀生成
  generateBtn.addEventListener('click', () => generateEmail(false));
  prefixInput.addEventListener('keydown', e => { if (e.key === 'Enter') generateEmail(false); });
  prefixInput.addEventListener('input', hideError);

  // 复制、保存、刷新
  copyBtn.addEventListener('click', copyEmail);
  saveBtn.addEventListener('click', saveEmail);
  refreshBtn.addEventListener('click', fetchMessages);
  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });

  // 全屏
  fullscreenBtn.addEventListener('click', toggleFullscreen);

  // 公告按钮
  adBtn.addEventListener('click', openCompose);
  composeClose.addEventListener('click', closeCompose);
  composeOverlay.addEventListener('click', e => { if (e.target === composeOverlay) closeCompose(); });
}

// ============ mail.tm 请求封装 ============
async function rawFetch(path, options = {}) {
  const headers = Object.assign({ 'Accept': 'application/json' }, options.headers || {});
  if (options.body) headers['Content-Type'] = 'application/json';
  return fetch(API_BASE + path, Object.assign({}, options, { headers }));
}

async function apiFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let res = await rawFetch(path, Object.assign({}, options, { headers }));
  
  // 401 重试一次（token 过期）
  if (res.status === 401 && account) {
    await doLogin();
    headers['Authorization'] = 'Bearer ' + token;
    res = await rawFetch(path, Object.assign({}, options, { headers }));
  }
  
  if (!res.ok) {
    const err = await safeJson(res);
    throw new Error((err && (err.detail || err['hydra:description'])) || ('HTTP ' + res.status));
  }
  return res;
}

async function safeJson(res) {
  try { return await res.json(); } catch (e) { return null; }
}

// ============ 侧边栏 ============
function openSidebar() {
  loadMailboxList();
  sidebar.classList.add('open');
  sidebarOverlay.classList.add('show');
}
function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarOverlay.classList.remove('show');
}

// ============ 邮箱池管理 ============
function getPool() {
  try {
    const raw = localStorage.getItem(POOL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}
function savePool(pool) {
  localStorage.setItem(POOL_KEY, JSON.stringify(pool));
}

function saveEmail() {
  if (!account) return;
  const item = { ...account, ts: Date.now() };
  const pool = getPool();
  const idx = pool.findIndex(p => p.address === account.address);
  if (idx >= 0) pool[idx] = item;
  else pool.unshift(item);
  savePool(pool);
  flashBtn(saveBtn, '已保存到邮箱池 ✓', '#00b894');
}

function loadMailboxList() {
  const pool = getPool();
  if (!pool.length) {
    mailboxList.innerHTML = '<div class="mailbox-empty">还没有保存的邮箱<br>点击 ➕ 新建邮箱</div>';
    return;
  }
  mailboxList.innerHTML = '';
  pool.forEach(item => {
    const div = document.createElement('div');
    div.className = 'mailbox-item' + (account && item.address === account.address ? ' active' : '');
    div.innerHTML = `
      <div class="mailbox-info">
        <div class="mailbox-addr">${escHtml(item.address)}</div>
        <div class="mailbox-tag">${account && item.address === account.address ? '● 使用中' : ''}</div>
      </div>
      <button class="mailbox-del" data-addr="${escHtml(item.address)}">×</button>
    `;
    div.querySelector('.mailbox-info').addEventListener('click', () => switchAccount(item));
    div.querySelector('.mailbox-del').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('确定删除这个邮箱？')) {
        removeAccount(item.address);
      }
    });
    mailboxList.appendChild(div);
  });
}

async function switchAccount(item) {
  if (item.address === (account && account.address)) {
    closeSidebar();
    return;
  }
  account = item;
  emailText.textContent = item.address;
  prefixInput.value = item.address.split('@')[0];
  copyBtn.disabled = false;
  saveBtn.disabled = false;
  closeSidebar();
  
  setEmailBusy(true);
  try {
    await doLogin();
    startPolling();
    localStorage.setItem(POOL_KEY + '_last', JSON.stringify(item));
  } catch(e) {
    showError('切换失败，请重新生成');
    account = null;
    emailText.textContent = '等待生成邮箱...';
    copyBtn.disabled = true;
    saveBtn.disabled = true;
  } finally {
    setEmailBusy(false);
  }
  loadMailboxList();
}

function removeAccount(addr) {
  let pool = getPool();
  pool = pool.filter(p => p.address !== addr);
  savePool(pool);
  if (account && account.address === addr) {
    account = null;
    token = null;
    stopPolling();
    emailText.textContent = '等待生成邮箱...';
    copyBtn.disabled = true;
    saveBtn.disabled = true;
    clearMailList();
    showEmpty();
  }
  loadMailboxList();
}

// ============ 生成邮箱 ============
const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
function randStr(len) {
  let s = '';
  for(let i=0; i<len; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)];
  return s;
}

async function generateEmail(randomMode) {
  hideError();
  setEmailBusy(true);
  emailText.textContent = '正在生成邮箱…';

  try {
    // 1. 获取可用域名
    const domainsRes = await apiFetch('/domains');
    const domains = (await domainsRes.json())
      .filter(d => d.isActive !== false)
      .map(d => d.domain);
    if (!domains.length) throw new Error('暂无可用域名');
    const domain = domains[Math.floor(Math.random() * domains.length)];

    // 2. 确定前缀
    let prefix;
    if (randomMode) {
      prefix = 'tm' + randStr(10);
    } else {
      prefix = (prefixInput.value || '').trim().toLowerCase();
      if (!prefix) prefix = randStr(8) + randStr(2, '0123456789');
      else if (!/^[a-z0-9][a-z0-9._-]*$/.test(prefix) || prefix.length > 20) {
        throw new Error('前缀只能用小写字母、数字、. _ -，且以字母或数字开头（2-20位）');
      }
    }

    // 3. 创建账号
    const address = prefix + '@' + domain;
    const password = 'aA1' + randStr(12);
    const res = await rawFetch('/accounts', {
      method: 'POST',
      body: JSON.stringify({ address, password })
    });

    if (res.status === 201) {
      account = { address, password };
    } else if (res.status === 422) {
      const err = await safeJson(res);
      const detail = (err && (err.detail || (err.violations && err.violations[0] && err.violations[0].message))) || '';
      if (/already used/i.test(detail)) {
        throw new Error('无法设置：该邮箱「' + address + '」已被别人占用，请换个前缀');
      }
      throw new Error('无法设置：' + (detail || '地址不合法'));
    } else {
      const err = await safeJson(res);
      throw new Error((err && err.detail) || ('创建失败 HTTP ' + res.status));
    }

    // 4. 登录拿 token
    await doLogin();

    // 5. 更新界面
    emailText.textContent = account.address;
    prefixInput.value = account.address.split('@')[0];
    copyBtn.disabled = false;
    saveBtn.disabled = false;
    clearMailList();
    startPolling();
    
    // 保存到最近使用
    localStorage.setItem(POOL_KEY + '_last', JSON.stringify(account));
    
  } catch (e) {
    console.error('生成失败', e);
    showError(e.message);
    if (!account) emailText.textContent = '等待生成邮箱...';
  } finally {
    setEmailBusy(false);
  }
}

async function doLogin() {
  if (!account) return;
  const res = await rawFetch('/token', {
    method: 'POST',
    body: JSON.stringify({ address: account.address, password: account.password })
  });
  if (res.status !== 200) throw new Error('登录失败 ' + res.status);
  const data = await res.json();
  token = data.token;
}

function setEmailBusy(busy) {
  refreshBtn.disabled = busy;
  generateBtn.disabled = busy;
  copyBtn.disabled = busy || !account;
  saveBtn.disabled = busy || !account;
}

async function restoreAccount(saved) {
  account = saved;
  emailText.textContent = saved.address;
  prefixInput.value = saved.address.split('@')[0];
  copyBtn.disabled = false;
  saveBtn.disabled = false;
  
  setEmailBusy(true);
  try {
    await doLogin();
    startPolling();
  } catch(e) {
    showError('保存的邮箱登录失败，请重新生成');
    account = null;
    emailText.textContent = '等待生成邮箱...';
    copyBtn.disabled = true;
    saveBtn.disabled = true;
  } finally {
    setEmailBusy(false);
  }
}

// ============ 复制 ============
function copyEmail() {
  const addr = emailText.textContent;
  if (!addr) return;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(addr).then(() => flashBtn(copyBtn, '已复制 ✓', '#00b894'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = addr; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    flashBtn(copyBtn, '已复制 ✓', '#00b894');
  }
}

function flashBtn(btn, text, color) {
  const orig = btn.textContent;
  btn.textContent = text;
  btn.style.background = color;
  setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 1500);
}

// ============ 轮询收信 ============
function startPolling() {
  stopPolling();
  fetchMessages();
  pollingTimer = setInterval(fetchMessages, 5000);
}
function stopPolling() {
  if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
}

async function fetchMessages() {
  if (!account || !token) return;
  refreshBtn.disabled = true;
  refreshBtn.textContent = '⏳ 刷新中…';

  try {
    const res = await apiFetch('/messages');
    const data = await res.json();
    
    // mail.tm 返回格式：纯数组 [] 或 { "hydra:member": [...] }
    let mails = [];
    if (Array.isArray(data)) mails = data;
    else if (data && Array.isArray(data['hydra:member'])) mails = data['hydra:member'];

    if (mails.length > 0) {
      renderMessages(mails);
    } else {
      showEmpty();
    }
  } catch (e) {
    console.error('拉取失败', e);
    mailList.innerHTML = '<div class="loading-row">⚠️ 拉取失败：' + escHtml(e.message) + '</div>';
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = '↻ 刷新';
  }
}

function clearMailList() { mailList.innerHTML = ''; }
function showEmpty() {
  mailList.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">📭</div>
      <div>暂无邮件</div>
      <div class="empty-sub">等待邮件到来…（每 5 秒自动刷新）</div>
    </div>`;
}

function renderMessages(msgs) {
  mailList.innerHTML = '';
  msgs.forEach(m => {
    const from = m.from ? (m.from.name || m.from.address || '') : '';
    const el = document.createElement('div');
    el.className = 'mail-item' + (m.seen ? '' : ' unread');
    el.innerHTML = `
      <div class="mail-from">${escHtml(from)}</div>
      <div class="mail-subject">${escHtml(m.subject || '(无主题)')}</div>
      <div class="mail-date">${formatDate(m.createdAt)}</div>`;
    el.addEventListener('click', () => openMessage(m.id));
    mailList.appendChild(el);
  });
}

async function openMessage(msgId) {
  try {
    const res = await apiFetch('/messages/' + msgId);
    const data = await res.json();

    document.getElementById('modalSubject').textContent = data.subject || '(无主题)';
    const from = data.from ? (data.from.name || data.from.address || '') : '';
    document.getElementById('modalFrom').textContent = from;
    document.getElementById('modalDate').textContent = formatDate(data.createdAt);

    const bodyEl = document.getElementById('modalBody');
    if (data.html) {
      bodyEl.innerHTML = data.html;
    } else if (data.text) {
      bodyEl.textContent = data.text;
    } else {
      bodyEl.textContent = '（无正文）';
    }
    modalOverlay.classList.add('active');
  } catch (e) {
    console.error('读取邮件失败', e);
  }
}
function closeModal() { modalOverlay.classList.remove('active'); }

// ============ 公告弹窗 ============
function openCompose() {
  composeOverlay.classList.add('active');
}
function closeCompose() {
  composeOverlay.classList.remove('active');
}

// ============ 全屏 ============
function setupFullscreen() {
  if (window.webcat && window.webcat.statusBar) {
    try { window.webcat.statusBar.setAdaptive(true); } catch(e){}
  }
  if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(()=>{});
  }
}
function toggleFullscreen() {
  if (document.fullscreenElement) {
    if (window.webcat && window.webcat.statusBar) {
      try { window.webcat.statusBar.setAdaptive(false); } catch(e){}
    }
    document.exitFullscreen().catch(()=>{});
    fullscreenBtn.textContent = '🖥️ 进入全屏';
  } else {
    if (window.webcat && window.webcat.statusBar) {
      try { window.webcat.statusBar.setAdaptive(true); } catch(e){}
    }
    document.documentElement.requestFullscreen().catch(()=>{});
    fullscreenBtn.textContent = '🖥️ 退出全屏';
  }
}

// ============ 工具 ============
function showError(msg) {
  errorMsg.textContent = '⚠️ ' + msg;
  errorMsg.classList.add('show');
}
function hideError() {
  errorMsg.classList.remove('show');
  errorMsg.textContent = '';
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(d) {
  if (!d) return '';
  try {
    const dt = new Date(d);
    if (isNaN(dt)) return d;
    return dt.toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  } catch(e) { return d; }
}
