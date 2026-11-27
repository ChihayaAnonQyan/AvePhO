import { setupEditor } from './editor.js';
import { renderRich } from './rich.mjs';

const el = (id) => document.getElementById(id);
let selected = null;
let published = {};
let release = null;
let busy = false;

function flash(text) { el('status').textContent = text; }

function showLogin(message) {
  el('dashboard').hidden = true;
  el('sign-in').hidden = false;
  flash(message);
}

async function request(path, body) {
  const options = {};
  if (body !== undefined) {
    options.method = 'POST';
    if (body instanceof FormData) options.body = body;
    else {
      options.headers = { 'content-type': 'application/json' };
      options.body = JSON.stringify(body);
    }
  }
  const response = await fetch(path, options);
  let data;
  try { data = await response.json(); } catch { throw new Error('后台暂时无法读取响应。'); }
  if (!response.ok) {
    const error = new Error(data.error);
    error.status = response.status;
    throw error;
  }
  return data;
}

function api(command, body) {
  return request('/api/' + command, body);
}

function syncButtons() {
  const pending = release?.state === 'pending';
  const saved = selected && el('title').value.trim() === selected.title && el('body').value.trim() === selected.body;
  el('publish').disabled = pending || !saved;
  el('withdraw').disabled = pending || !saved || !published[selected?.id];
}

function select(draft) {
  selected = draft;
  el('title').value = draft?.title || '';
  el('body').value = draft?.body || '';
  el('preview-panel').hidden = true;
  syncButtons();
}

async function load(keep = false) {
  const { drafts, published: live, release: latest } = await api('announcements');
  const list = el('list');
  published = live;
  release = latest;
  list.replaceChildren();
  for (const draft of drafts) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    let label = '草稿';
    if (published[draft.id]) label = published[draft.id] === draft.revision ? '已上线' : '已上线 · 有新草稿';
    button.textContent = `${draft.title}（${label}）`;
    button.onclick = () => select(draft);
    item.append(button);
    list.append(item);
  }
  el('release-status').textContent = release?.state === 'pending' ? '已提交发布请求，等待核对官网。' :
    release?.state === 'live' ? '最近一次更新已在官网确认。' : '暂无发布记录。';
  el('check').hidden = release?.state !== 'pending';
  el('retry').hidden = release?.state !== 'pending';
  el('run').hidden = !release?.runUrl;
  if (release?.runUrl) el('run').href = release.runUrl;
  if (!keep) select(drafts.find((draft) => draft.id === selected?.id) || null);
  else syncButtons();
}

async function perform(action, message) {
  if (busy) return;
  busy = true;
  try {
    await action();
    flash(message);
  } catch (error) {
    if (error.status === 401) {
      showLogin('登录已失效，请重新输入密码。');
    } else {
      flash(error.message);
      try { await load(true); } catch { /* Keep form contents for a retry. */ }
    }
  } finally {
    busy = false;
  }
}

el('new').onclick = () => { select(null); el('title').focus(); };
el('editor').oninput = syncButtons;
el('editor').onsubmit = (event) => {
  event.preventDefault();
  void perform(async () => {
    select(await api('save', {
      id: selected?.id, revision: selected?.revision,
      title: el('title').value, body: el('body').value, format: 'markdown',
    }));
    await load();
  }, '草稿已保存。');
};
el('preview').onclick = () => {
  el('preview-title').textContent = el('title').value;
  el('preview-body').innerHTML = renderRich(el('body').value);
  el('preview-panel').hidden = false;
};
for (const action of ['publish', 'withdraw']) {
  el(action).onclick = () => {
    if (!confirm(action === 'publish' ? '确认向所有访客发布当前保存的版本？' : '确认从官网撤回这篇公告？')) return;
    void perform(async () => {
      await api(action, { id: selected.id, revision: selected.revision });
      await load();
    }, '部署已触发。可点「核对官网」确认结果。');
  };
}
el('check').onclick = () => void perform(async () => {
  await api('check', {});
  await load(true);
}, '已核对官网。');
el('retry').onclick = () => void perform(async () => {
  await api('retry', {});
  await load(true);
}, '已发起重试。');

const panels = ['papers', 'announcements', 'article'];
function showPanel(panel) {
  for (const name of panels) {
    el(name + '-panel').hidden = name !== panel;
    el(name + '-tab').setAttribute('aria-pressed', name === panel);
  }
  el('editor-deployment').hidden = panel === 'announcements';
}
const editor = setupEditor({ el, api, flash, showLogin });
for (const panel of panels) el(panel + '-tab').onclick = () => showPanel(panel);
async function loadDashboard() {
  await Promise.all([load(), editor.load()]);
}
el('sign-in').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = el('password');
  const button = el('sign-in-button');
  if (button.disabled) return;
  button.disabled = true;
  flash('正在登录…');
  try {
    await request('/auth/login', { password: password.value });
    password.value = '';
    await loadDashboard();
    el('sign-in').hidden = true;
    el('dashboard').hidden = false;
    flash('');
  } catch (error) {
    password.select();
    flash(error.message || '登录失败，请稍后重试。');
  } finally {
    button.disabled = false;
  }
});

try {
  await loadDashboard();
  el('dashboard').hidden = false;
  flash('');
} catch (error) {
  if (error.status === 401) showLogin('请输入管理员密码。');
  else flash(error.message);
}
