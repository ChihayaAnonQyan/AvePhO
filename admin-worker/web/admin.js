const el = (id) => document.getElementById(id);
let selected = null;
let published = {};
let release = null;
let busy = false;
let selectedEdition = null;
let paperRevision = null;

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
      title: el('title').value, body: el('body').value,
    }));
    await load();
  }, '草稿已保存。');
};
el('preview').onclick = () => {
  el('preview-title').textContent = el('title').value;
  el('preview-body').textContent = el('body').value;
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

function editEdition(edition = null) {
  selectedEdition = edition;
  paperRevision = null;
  el('paper-editor').reset();
  el('paper-form-title').textContent = edition ? `更新第 ${edition.number} 届` : '新增届次';
  for (const name of ['number', 'year']) {
    el('paper-' + name).value = edition?.[name] ?? '';
    el('paper-' + name).readOnly = Boolean(edition);
  }
  el('paper-file').required = !edition;
  el('paper-version').required = !edition;
  el('solutions-version').required = false;
  el('paper-current').hidden = !edition;
  if (edition) {
    el('paper-current').textContent = `已登记试题 ${edition.files.paper}，答案 ${edition.files.solutions ?? '待补传'}。只需选择本次要上传的文件。`;
  }
}

async function loadPapers() {
  const { editions } = await api('papers');
  const status = { live: '已上线', pending: '待上线', unknown: '暂无法核对' };
  el('paper-list').replaceChildren();
  for (const edition of [...editions].reverse()) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `第 ${edition.number} 届 · ${edition.year}（${status[edition.state]}）`;
    button.onclick = () => {
      if (busy) return;
      editEdition(edition);
      el('paper-file').focus();
    };
    item.append(button);
    el('paper-list').append(item);
  }
  el('paper-retry').hidden = !editions.some((edition) => edition.state !== 'live');
  return editions;
}

async function paperAction(action) {
  if (busy) return;
  busy = true;
  const controls = [...el('paper-editor').elements, el('paper-new')];
  for (const control of controls) control.disabled = true;
  const status = el('paper-status');
  status.textContent = '正在处理…';
  try { status.textContent = await action(); }
  catch (error) {
    if (error.status === 401) showLogin('登录已失效，请重新输入密码。');
    status.textContent = error.message;
  } finally {
    for (const control of controls) control.disabled = false;
    busy = false;
  }
}

function showPanel(panel) {
  for (const name of ['announcements', 'papers']) {
    el(name + '-panel').hidden = name !== panel;
    el(name + '-tab').setAttribute('aria-pressed', name === panel);
  }
}

el('announcements-tab').onclick = () => showPanel('announcements');
el('papers-tab').onclick = () => {
  showPanel('papers');
  void paperAction(async () => {
    const editions = await loadPapers();
    return editions.length ? '' : '第一届原有资料已在官网。可在这里发布后续届次。';
  });
};
el('paper-new').onclick = () => {
  editEdition();
  el('paper-number').focus();
};
el('paper-editor').oninput = () => {
  paperRevision = null;
  el('paper-version').required = !selectedEdition || Boolean(el('paper-file').files.length);
  el('solutions-version').required = Boolean(el('solutions-file').files.length);
};
el('paper-editor').onsubmit = (event) => {
  event.preventDefault();
  if (busy) return;
  const chosen = ['paper-file', 'solutions-file'].map((id) => el(id).files[0]).filter(Boolean);
  if (!chosen.length || chosen.some((file) => file.size > 10 * 1024 * 1024)) {
    el('paper-status').textContent = '请选择要上传的 PDF，每份最多 10 MiB。';
    return;
  }
  if (!confirm('确认发布这些文件？试卷将写入官网使用的 GitHub 仓库。')) return;
  const form = new FormData(event.currentTarget);
  paperRevision ??= crypto.randomUUID();
  form.set('revision', paperRevision);
  form.set('previous', selectedEdition?.revision ?? '');
  void paperAction(async () => {
    let deployment;
    try { deployment = await api('papers/publish', form); }
    catch (error) {
      try {
        const editions = await loadPapers();
        const saved = editions.find((edition) => edition.revision === form.get('revision'));
        if (saved) editEdition(saved);
      } catch { /* Keep the selected files when the result is unknown. */ }
      throw error;
    }
    const number = Number(form.get('number'));
    editEdition();
    if (deployment.runUrl) el('paper-run').href = deployment.runUrl;
    try {
      const editions = await loadPapers();
      const saved = editions.find((edition) => edition.number === number);
      if (saved) editEdition(saved);
      if (saved?.state === 'live') return '已核对，当前版本已在官网上线。';
    } catch { /* Deployment was accepted even if refreshing the list failed. */ }
    return '已提交部署。完成后点「核对官网」。';
  });
};
el('paper-check').onclick = () => void paperAction(async () => {
  const editions = await loadPapers();
  if (!editions.length) return '暂无新增届次。';
  if (editions.some((edition) => edition.state === 'unknown')) return '暂时无法读取官网状态。';
  return editions.some((edition) => edition.state === 'pending') ? '仍有资料待上线。' : '所有已登记届次均已在官网上线。';
});
el('paper-retry').onclick = () => void paperAction(async () => {
  const deployment = await api('papers/retry', {});
  if (deployment.runUrl) el('paper-run').href = deployment.runUrl;
  return '已发起重试。完成后点「核对官网」。';
});

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
    await load(true);
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
  await load();
  el('dashboard').hidden = false;
  flash('');
} catch (error) {
  if (error.status === 401) showLogin('请输入管理员密码。');
  else flash(error.message);
}
