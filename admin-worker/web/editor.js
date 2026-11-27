import { renderRich } from './rich.mjs';

const CHUNK_BYTES = 512 * 1024;
const FILE_LIMIT = 10 * 1024 * 1024;
const TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const RESOURCES = ['paper', 'solutions'];

async function uploadFile(file, report) {
  const mime = file.type || TYPES[file.name.split('.').at(-1).toLowerCase()];
  if (!Object.values(TYPES).includes(mime) || !file.size || file.size > FILE_LIMIT) {
    throw new Error('请选择 PDF、PNG、JPEG 或 WebP 文件，单份最多 10 MiB。');
  }
  const query = new URLSearchParams({ id: crypto.randomUUID(), name: file.name, size: file.size, mime });
  const count = Math.ceil(file.size / CHUNK_BYTES);
  let result;
  for (let part = 0; part < count; part++) {
    query.set('part', String(part));
    report(`正在上传 ${file.name}（${part + 1}/${count}）…`);
    const body = file.slice(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES, 'application/octet-stream');
    let response;
    try { response = await fetch('/api/editor/file?' + query, { method: 'POST', body }); }
    catch { response = await fetch('/api/editor/file?' + query, { method: 'POST', body }); }
    result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error);
      error.status = response.status;
      throw error;
    }
  }
  if (!result?.ready) throw new Error('文件尚未上传完整，请重试。');
  return { id: result.id, name: result.name };
}

export function setupEditor({ el, api, flash, showLogin }) {
  const forms = { edition: el('edition-form'), article: el('article-form') };
  const selected = { edition: null, article: null };
  const dirty = { edition: false, article: false };
  const articleFiles = { images: [], attachments: [] };
  const stagedPdfs = {};
  const resource = (kind, name) => el('editor-' + kind).querySelector('.resource-' + name);
  let items = [];
  let busy = false;
  const work = el('editor-deployment');
  const panels = [el('papers-panel'), el('article-panel')];

  function buttons() {
    for (const name of ['edition', 'article']) {
      const current = selected[name];
      const release = el(name + '-release-button');
      release.disabled = !current || !current.revision || dirty[name] || current.revision === current.publishedRevision;
      release.textContent = current?.publishedRevision
        ? '发布更新' : name === 'edition' ? '公开届次' : '公开文章';
    }
    el('article-withdraw').disabled = !selected.article?.publishedRevision || dirty.article;
  }

  function setDirty(kind) {
    dirty[kind] = true;
    buttons();
  }

  function scheduleField(kind) {
    const timed = resource(kind, 'mode').value === 'later';
    resource(kind, 'time').hidden = !timed;
    resource(kind, 'at').required = timed;
  }

  function renderFiles() {
    const list = el('article-files');
    list.replaceChildren();
    for (const [type, files] of Object.entries(articleFiles)) {
      for (const [index, file] of files.entries()) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = '/api/editor/file/' + file.id;
        link.textContent = file.name;
        link.target = '_blank';
        link.rel = 'noopener';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '移除';
        remove.onclick = () => {
          if (type === 'images') {
            const body = el('article-body');
            body.value = body.value.replace(new RegExp('!\\[[^\\]]*\\]\\(asset:' + file.id + '\\)', 'g'), '');
          }
          files.splice(index, 1);
          renderFiles();
          setDirty('article');
        };
        item.append(link, ' ', remove);
        list.append(item);
      }
    }
  }

  function edit(kind, item = null) {
    selected[kind] = item;
    const data = item?.draft;
    forms[kind].reset();
    dirty[kind] = false;
    if (kind === 'edition') {
      el('editor-edition-number').value = data?.number ?? '';
      el('editor-edition-number').readOnly = Boolean(item);
      el('editor-edition-year').value = data?.year ?? '';
      for (const key of RESOURCES) {
        delete stagedPdfs[key];
        const file = data?.files[key];
        resource(key, 'current').textContent = file?.id ? '已上传 · ' + file.version : '尚未上传';
        resource(key, 'version').value = file?.version || 'v1.0';
        resource(key, 'mode').value = file?.at ? 'later' : 'now';
        resource(key, 'at').value = file?.at ?? '';
        scheduleField(key);
      }
    } else {
      el('article-title').value = data?.title ?? '';
      el('article-body').value = data?.body ?? '';
      for (const key of Object.keys(articleFiles)) articleFiles[key] = [...(data?.[key] ?? [])];
      el('article-preview-panel').hidden = true;
      renderFiles();
    }
    buttons();
  }

  async function load() {
    ({ items } = await api('editor/items'));
    for (const kind of ['edition', 'article']) {
      const list = el(kind + '-items');
      list.replaceChildren();
      for (const item of items.filter((entry) => entry.kind === kind)) {
        const row = document.createElement('li');
        const button = document.createElement('button');
        const name = kind === 'edition' ? `第 ${item.draft.number} 届` : item.draft.title;
        const state = item.revision === item.publishedRevision ? '已提交公开'
          : item.publishedRevision ? '有新草稿' : '草稿';
        button.type = 'button';
        button.textContent = `${name}（${state}）`;
        button.onclick = () => {
          if (!dirty[kind] || confirm('放弃此表单中尚未保存的修改？')) edit(kind, item);
        };
        row.append(button);
        list.append(row);
      }
    }
  }

  async function action(job) {
    if (busy) return;
    busy = true;
    for (const panel of [...panels, work]) panel.inert = true;
    try { flash(await job()); }
    catch (error) {
      if (error.status === 401) showLogin('登录已失效，请重新登录。');
      else flash(error.message);
    } finally {
      busy = false;
      for (const panel of [...panels, work]) panel.inert = false;
    }
  }

  const newItem = (kind) => {
    if (!dirty[kind] || confirm('放弃此表单中尚未保存的修改？')) edit(kind);
  };
  el('new-edition').onclick = () => newItem('edition');
  el('new-article').onclick = () => newItem('article');
  for (const kind of RESOURCES) {
    resource(kind, 'mode').onchange = () => scheduleField(kind);
    resource(kind, 'file').onchange = () => { delete stagedPdfs[kind]; };
  }

  async function editionDraft() {
    const number = el('editor-edition-number').valueAsNumber;
    const year = el('editor-edition-year').valueAsNumber;
    const files = {};
    for (const key of RESOURCES) {
      const upload = resource(key, 'file').files[0];
      const prior = selected.edition?.draft?.files[key];
      const at = resource(key, 'mode').value === 'later' ? resource(key, 'at').value : null;
      const version = resource(key, 'version').value.trim();
      if (!upload && !prior?.id && at === null) continue;
      if ((upload || prior?.id) && !version) throw new Error('请填写已上传 PDF 的版本。');
      if (upload && !stagedPdfs[key]) stagedPdfs[key] = await uploadFile(upload, flash);
      files[key] = { id: stagedPdfs[key]?.id ?? prior?.id ?? null, at, version };
    }
    return { number, year, files };
  }

  function articleDraft() {
    return { title: el('article-title').value, body: el('article-body').value, ...articleFiles };
  }

  const draftReaders = { edition: editionDraft, article: articleDraft };
  for (const kind of ['edition', 'article']) {
    forms[kind].oninput = () => setDirty(kind);
    forms[kind].onsubmit = (event) => {
      event.preventDefault();
      void action(async () => {
        const draft = await draftReaders[kind]();
        selected[kind] ??= { id: crypto.randomUUID(), revision: 0 };
        const { id, revision } = selected[kind];
        const { item } = await api('editor/save', { id, revision, kind, draft });
        edit(kind, item);
        await load();
        return '已保存草稿。';
      });
    };
    el(kind + '-release-button').onclick = () => {
      if (!confirm(kind === 'edition' ? '公开已保存的届次及文件发布时间？' : '公开已保存的文章与附件？')) return;
      void action(() => deploy(kind, 'publish'));
    };
  }

  async function deploy(kind, operation) {
    const current = selected[kind];
    const { runUrl, deployed } = await api('editor/' + operation, current ? {
      id: current.id, revision: current.revision,
    } : {});
    if (runUrl) el('editor-run').href = runUrl;
    if (current) {
      await load();
      edit(kind, items.find((item) => item.id === current.id));
    }
    return deployed ? '已触发官网部署。查看部署记录确认完成。'
      : '公开状态已保存，官网部署触发失败。可点「重新部署官网」。';
  }

  el('editor-retry').onclick = () => void action(() => deploy(null, 'deploy'));
  el('article-withdraw').onclick = () => {
    if (confirm('从官网撤回这篇文章及其附件？')) void action(() => deploy('article', 'withdraw'));
  };
  el('article-preview').onclick = () => {
    const preview = el('article-preview-panel');
    const title = document.createElement('h3');
    title.textContent = el('article-title').value;
    const body = document.createElement('div');
    body.innerHTML = renderRich(el('article-body').value, '/api/editor/file/');
    preview.replaceChildren(title, body);
    preview.hidden = false;
  };

  for (const [id, key] of [['article-image-upload', 'images'], ['article-attachment-upload', 'attachments']]) {
    el(id).onchange = () => {
      const file = el(id).files[0];
      if (!file) return;
      void action(async () => {
        if (articleFiles[key].length >= 10) throw new Error('图片和 PDF 附件各最多 10 个。');
        const asset = await uploadFile(file, flash);
        articleFiles[key].push(asset);
        el(id).value = '';
        if (key === 'images') {
          const body = el('article-body');
          const alt = asset.name.replace(/\.[^.]+$/, '').replace(/[\[\]\\]/g, '');
          body.setRangeText(`\n\n![${alt}](asset:${asset.id})\n\n`, body.selectionStart, body.selectionEnd, 'end');
        }
        renderFiles();
        setDirty('article');
        return '文件已上传。保存草稿后可继续编辑。';
      });
    };
  }
  return { load };
}
