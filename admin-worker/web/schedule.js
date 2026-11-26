const LANGUAGES = ['zh-CN', 'zh-TW', 'en', 'ja'];
const MAX_EVENTS = 20;
const WORKFLOW = 'https://github.com/ChihayaAnonQyan/AvePhO/actions/workflows/pages.yml';

export function setupSchedule({ el, api, showLogin, showPanel }) {
  const list = el('schedule-list');
  let settings = null;
  let dirty = false;
  let busy = false;

  const field = (row, name) => row.querySelector('[data-field="' + name + '"]');
  const status = (text) => { el('edition-status').textContent = text; };

  function renderControls() {
    const release = settings?.release;
    const pending = release?.state === 'pending';
    el('edition-fields').disabled = busy || !settings;
    el('schedule-add').disabled = list.children.length >= MAX_EVENTS;
    el('edition-publish').disabled = dirty || pending || !settings?.revision || settings.revision === release?.revision;
    for (const id of ['edition-check', 'edition-retry']) {
      el(id).hidden = !pending;
      el(id).disabled = busy;
    }
    el('edition-run').hidden = !pending && !release?.runUrl;
    el('edition-run').href = release?.runUrl || WORKFLOW;
    el('edition-release').textContent = pending ? '已提交发布，等待核对官网。'
      : dirty ? '有尚未保存的更改。'
      : !settings?.revision ? '官网当前沿用第一届资料。'
      : release?.revision === settings.revision ? '当前保存的设置已上线。' : '草稿已保存，等待发布。';
  }

  function changed() {
    dirty = true;
    renderControls();
  }

  function addEvent(event = {}) {
    const row = el('schedule-event').content.firstElementChild.cloneNode(true);
    for (const language of LANGUAGES) field(row, language).value = event.titles?.[language] ?? '';
    for (const name of ['starts', 'ends']) field(row, name).value = event[name] ?? '';
    field(row, 'status').value = event.status ?? 'auto';
    const notice = field(row, 'announcement');
    for (const { id, title } of settings.announcements) notice.add(new Option(title, id));
    if (event.announcement && !settings.announcements.some(({ id }) => id === event.announcement)) {
      notice.add(new Option('原公告暂未公开', event.announcement));
    }
    notice.value = event.announcement ?? '';
    row.querySelector('[data-remove]').onclick = () => {
      row.remove();
      changed();
      el('schedule-add').focus();
    };
    list.append(row);
    return field(row, 'zh-CN');
  }

  function readEvents() {
    return Array.from(list.children, (row) => ({
      titles: Object.fromEntries(LANGUAGES.map((lang) => [lang, field(row, lang).value])),
      starts: field(row, 'starts').value,
      ends: field(row, 'ends').value,
      status: field(row, 'status').value,
      announcement: field(row, 'announcement').value,
    }));
  }

  function renderDraft() {
    const { number, year, events } = settings.draft;
    el('edition-number').value = number;
    el('edition-year').value = year;
    list.replaceChildren();
    events.forEach(addEvent);
    dirty = false;
  }

  async function act(action) {
    if (busy) return;
    busy = true;
    renderControls();
    status('正在处理…');
    try { status(await action()); }
    catch (error) {
      if (error.status === 401) showLogin('登录已失效，请重新输入密码。');
      status(error.message);
    } finally {
      busy = false;
      renderControls();
    }
  }

  el('edition-tab').onclick = () => {
    showPanel('edition');
    if (dirty) return;
    void act(async () => {
      settings = await api('edition');
      renderDraft();
      return '';
    });
  };
  el('edition-editor').oninput = changed;
  el('schedule-add').onclick = () => {
    if (busy || !settings || list.children.length >= MAX_EVENTS) return;
    const title = addEvent();
    changed();
    title.focus();
  };
  el('edition-editor').onsubmit = (event) => {
    event.preventDefault();
    if (busy || !settings) return;
    const payload = {
      revision: settings.revision,
      number: el('edition-number').valueAsNumber,
      year: el('edition-year').valueAsNumber,
      events: readEvents(),
    };
    void act(async () => {
      const saved = await api('edition/save', payload);
      Object.assign(settings, saved);
      renderDraft();
      return '草稿已保存。';
    });
  };
  el('edition-publish').onclick = () => {
    if (!confirm('确认将已保存的当前届次与日程立即发布到官网？')) return;
    void act(async () => {
      try {
        const { release } = await api('edition/publish', { revision: settings.revision });
        settings.release = release;
        return '已提交部署。完成后点「核对官网」。';
      } catch (error) {
        // The snapshot may already be saved even if starting the deployment failed.
        try { settings.release = (await api('edition')).release; } catch { /* Keep the editor intact. */ }
        throw error;
      }
    });
  };
  el('edition-check').onclick = () => void act(async () => {
    const { release } = await api('edition/check', {});
    settings.release = release;
    return release?.state === 'live' ? '已核对官网，发布成功。' : '仍待上线，可以稍后再核对。';
  });
  el('edition-retry').onclick = () => void act(async () => {
    const { release } = await api('edition/retry', {});
    settings.release = release;
    return '已发起重试。完成后点「核对官网」。';
  });
}
