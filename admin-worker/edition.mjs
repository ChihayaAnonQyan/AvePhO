import { dispatchPages } from './github.mjs';

const LANGUAGES = ['zh-CN', 'zh-TW', 'en', 'ja'];
const STATUSES = ['auto', 'upcoming', 'ongoing', 'completed'];
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_EVENTS = 20;

const loadSettings = (db) => db.prepare('SELECT * FROM edition_schedule WHERE id = 1').first();
const releaseView = (row) => row.release_id && ({
  id: row.release_id, state: row.state, revision: row.published_revision, runUrl: row.run_url,
});

export async function exportedEdition(db) {
  const row = await loadSettings(db);
  return {
    scheduleReleaseId: row.release_id,
    editionSchedule: row.published ? JSON.parse(row.published) : null,
  };
}

function validDate(value) {
  if (typeof value !== 'string' || !/^[2-9]\d{3}-\d\d-\d\dT\d\d:\d\d$/.test(value)) return false;
  const date = new Date(value + ':00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 16) === value;
}

function cleanEvent(event) {
  if (!validDate(event?.starts) ||
      (event.ends !== '' && (!validDate(event.ends) || event.ends <= event.starts)) ||
      !STATUSES.includes(event.status) ||
      typeof event.announcement !== 'string' || (event.announcement && !UUID.test(event.announcement))) return null;
  const titles = {};
  for (const language of LANGUAGES) {
    const value = event.titles?.[language];
    if (typeof value !== 'string' || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) return null;
    if (value.trim()) titles[language] = value.trim();
  }
  if (!titles['zh-CN']) return null;
  return { titles, starts: event.starts, ends: event.ends, status: event.status, announcement: event.announcement };
}

async function saveDraft(db, input) {
  const { revision, number, year, events } = input ?? {};
  if (!Number.isInteger(number) || number < 1 || number > 999 ||
      !Number.isInteger(year) || year < 2026 || year > 9999 ||
      (number === 1 && year !== 2026) || !Array.isArray(events) || events.length > MAX_EVENTS) {
    return [{ error: '请核对届次、举办年份和日程数量。第一届年份为 2026，最多填写 20 个节点。' }, 400];
  }
  const cleaned = events.map(cleanEvent);
  if (cleaned.some((event) => !event)) {
    return [{ error: '请核对日程名称、时间范围和状态。结束时间应晚于开始时间。' }, 400];
  }
  const draft = { number, year, events: cleaned.sort((a, b) => a.starts.localeCompare(b.starts)) };
  const updated = await db.prepare(`
    UPDATE edition_schedule SET draft = ?, draft_revision = draft_revision + 1
    WHERE id = 1 AND draft_revision = ?
  `).bind(JSON.stringify(draft), revision).run();
  if (!updated.meta.changes) return [{ error: '草稿已有更新，请刷新页面后再编辑。' }, 409];
  return [{ draft, revision: revision + 1 }, 200];
}

async function trigger(env, release) {
  try {
    const runUrl = await dispatchPages(env);
    await env.DB.prepare('UPDATE edition_schedule SET run_url = ? WHERE release_id = ?').bind(runUrl, release.id).run();
    return [{ release: { ...release, runUrl } }, 202];
  } catch {
    return [{ error: '发布版本已保存。暂时无法确认部署已启动，可点「重试部署」。', release }, 502];
  }
}

async function publish(env, revision) {
  const id = crypto.randomUUID();
  const updated = await env.DB.prepare(`
    UPDATE edition_schedule
    SET published = draft, published_revision = draft_revision, release_id = ?, state = 'pending', run_url = NULL
    WHERE id = 1 AND draft_revision = ? AND draft_revision > 0
      AND state IS NOT 'pending' AND published_revision IS NOT draft_revision
  `).bind(id, revision).run();
  if (!updated.meta.changes) return [{ error: '请确认草稿已保存，且已有的发布已完成。' }, 409];
  return trigger(env, { id, revision, state: 'pending', runUrl: null });
}

async function checkRelease(env, site, release) {
  try {
    const response = await fetch(`${site}release.json?schedule=${release.id}&check=${Date.now()}`, {
      cache: 'no-store', redirect: 'error',
    });
    const marker = response.ok ? await response.json() : null;
    if (marker?.scheduleReleaseId === release.id) {
      await env.DB.prepare("UPDATE edition_schedule SET state = 'live' WHERE release_id = ? AND state = 'pending'")
        .bind(release.id).run();
      release.state = 'live';
    }
    return [{ release }, 200];
  } catch {
    return [{ error: '暂时无法核对官网，请稍后重试。' }, 502];
  }
}

export async function editionResponse(env, site, path, input, announcements) {
  if (path === '/api/edition') {
    const row = await loadSettings(env.DB);
    return [{
      draft: JSON.parse(row.draft), revision: row.draft_revision, release: releaseView(row),
      announcements: announcements.map(({ id, title }) => ({ id, title })),
    }, 200];
  }
  if (path === '/api/edition/save' || path === '/api/edition/publish') {
    if (!Number.isInteger(input?.revision) || input.revision < 0) {
      return [{ error: '请重新加载届次设置。' }, 400];
    }
    if (path === '/api/edition/save') return saveDraft(env.DB, input);
    return publish(env, input.revision);
  }
  const release = releaseView(await loadSettings(env.DB));
  if (path === '/api/edition/retry') {
    return release?.state === 'pending'
      ? trigger(env, release)
      : [{ error: '当前没有待上线的届次设置。' }, 409];
  }
  return release?.state === 'pending' ? checkRelease(env, site, release) : [{ release }, 200];
}
