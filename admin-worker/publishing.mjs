import { dispatchPages } from './github.mjs';
import { allReady, IMAGES, PDF, UUID } from './editor-files.mjs';

const KINDS = ['edition', 'article'];
const PAPERS = ['paper', 'solutions'];
const bad = (error, status = 400) => [{ error }, status];
const getItem = (db, id) => db.prepare('SELECT * FROM editorial_items WHERE id = ?').bind(id).first();

function view(row) {
  return {
    id: row.id, kind: row.kind, revision: row.revision, publishedRevision: row.published_revision,
    draft: JSON.parse(row.draft), publishedAt: row.published_at,
  };
}

function openDate(at) {
  if (typeof at !== 'string' || !/^[2-9]\d{3}-\d\d-\d\dT\d\d:\d\d$/.test(at)) return NaN;
  const date = new Date(at + 'Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 16) === at
    ? Date.parse(at + ':00+08:00') : NaN;
}

function cleanEdition(draft) {
  const { number, year } = draft;
  if (!Number.isInteger(number) || number < 2 || number > 999 ||
      !Number.isInteger(year) || year < 2026 || year > 9999) return null;
  const files = {};
  for (const kind of PAPERS) {
    const file = draft.files?.[kind];
    if (!file) continue;
    if (typeof file.version !== 'string' || file.version.length > 32 || /[\x00-\x1f\x7f]/.test(file.version) ||
        (file.id !== null && (!UUID.test(file.id || '') || !file.version.trim())) ||
        (file.at === null ? file.id === null : !Number.isFinite(openDate(file.at)))) return null;
    files[kind] = { id: file.id, version: file.version.trim(), at: file.at };
  }
  if (files.paper?.id && files.paper.id === files.solutions?.id) return null;
  return { number, year, files };
}

function cleanArticle(draft) {
  const { title, body } = draft;
  if (typeof title !== 'string' || !title.trim() || title.length > 120 ||
      typeof body !== 'string' || !body.trim() || body.length > 12000) return null;
  const files = {};
  for (const key of ['images', 'attachments']) {
    const list = draft[key];
    if (!Array.isArray(list) || list.length > 10 || new Set(list.map((item) => item?.id)).size !== list.length) return null;
    files[key] = [];
    for (const item of list) {
      if (!UUID.test(item?.id || '') || typeof item.name !== 'string' || !item.name.trim() ||
          item.name.length > 180 || /[\x00-\x1f\x7f]/.test(item.name)) return null;
      files[key].push({ id: item.id, name: item.name });
    }
  }
  for (const [, id] of body.matchAll(/asset:([a-f0-9-]{36})/g)) {
    if (!files.images.some((item) => item.id === id)) return null;
  }
  if (files.images.some(({ id }) => files.attachments.some((item) => item.id === id))) return null;
  return { title: title.trim(), body: body.trim(), ...files };
}

function fileTypes(kind, draft) {
  if (kind === 'edition') return new Map(Object.values(draft.files).filter(({ id }) => id).map(({ id }) => [id, [PDF]]));
  return new Map([...draft.images.map(({ id }) => [id, IMAGES]), ...draft.attachments.map(({ id }) => [id, [PDF]])]);
}

async function save(db, input) {
  const { id, kind, revision, draft } = input ?? {};
  if (!UUID.test(id || '') || !KINDS.includes(kind) || !Number.isInteger(revision) || revision < 0 ||
      !draft || typeof draft !== 'object') return bad('请核对编辑内容。');
  const value = kind === 'edition' ? cleanEdition(draft) : cleanArticle(draft);
  if (!value || !await allReady(db, fileTypes(kind, value))) return bad('请核对必填信息、公开时间和已上传的文件。');
  const serialized = JSON.stringify(value);
  const result = revision === 0 ? await db.prepare(`
    INSERT OR IGNORE INTO editorial_items (id, kind, edition_number, revision, draft) VALUES (?, ?, ?, 1, ?)
  `).bind(id, kind, value.number ?? null, serialized).run() : await db.prepare(`
    UPDATE editorial_items SET draft = ?, revision = revision + 1
    WHERE id = ? AND kind = ? AND revision = ? AND edition_number IS ?
  `).bind(serialized, id, kind, revision, value.number ?? null).run();
  const saved = await getItem(db, id);
  if (result.meta.changes || (saved?.kind === kind && saved.revision === revision + 1 && saved.draft === serialized)) {
    return [{ item: view(saved) }, 200];
  }
  return bad('届次已存在，或这个草稿有更新。请重新打开列表后再编辑。', 409);
}

async function deploy(env) {
  try {
    return [{ runUrl: await dispatchPages(env), deployed: true }, 202];
  } catch {
    return [{ runUrl: null, deployed: false }, 202];
  }
}

async function publish(env, input, withdraw) {
  const { id, revision } = input ?? {};
  if (!UUID.test(id || '') || !Number.isInteger(revision)) return bad('请先保存草稿。');
  const db = env.DB;
  const row = await getItem(db, id);
  if (!row || row.revision !== revision) return bad('草稿已有更新，请重新打开后再提交。', 409);
  if (withdraw && row.kind !== 'article') return bad('此操作仅用于撤回文章。');
  if (withdraw && !row.published) return bad('这篇文章当前未公开。', 409);
  if (!withdraw && row.published_revision === revision) return deploy(env);

  const now = Date.now();
  const prior = row.published ? JSON.parse(row.published) : null;
  const draft = JSON.parse(row.draft);
  const pub = withdraw ? null : structuredClone(draft);
  const files = new Map();
  if (pub && row.kind === 'edition') {
    for (const [kind, file] of Object.entries(pub.files)) {
      const old = prior?.files[kind];
      // Saving an unrelated edit must not reset an already published time.
      const scheduled = file.at !== null;
      const opensAt = scheduled ? openDate(file.at)
        : old?.id === file.id && old.scheduled === false ? old.opensAt : now;
      if (file.id && old?.id === file.id && old.opensAt <= now && opensAt > now) {
        return bad('这份文件已经公开。请上传新版本，再为新文件设定公开时间。', 409);
      }
      pub.files[kind] = { id: file.id, version: file.version, opensAt, scheduled };
      if (file.id) files.set(file.id, opensAt);
    }
  } else if (pub) {
    for (const id of fileTypes(row.kind, pub).keys()) files.set(id, now);
  }
  const payload = pub && JSON.stringify(pub);
  const oldPayload = row.published;
  const result = await db.batch([
    db.prepare(`
      UPDATE editorial_items SET published = ?, published_revision = ?, published_at = ?
      WHERE id = ? AND revision = ? AND published IS ?
    `).bind(payload, withdraw ? null : revision, withdraw ? null : row.published_at ?? new Date(now).toISOString(),
      id, revision, oldPayload),
    db.prepare(`DELETE FROM editorial_public_files WHERE item = ? AND EXISTS (
      SELECT 1 FROM editorial_items WHERE id = ? AND revision = ? AND published IS ?
    )`).bind(id, id, revision, payload),
    ...[...files].map(([file, opensAt]) => db.prepare(`
      INSERT INTO editorial_public_files (item, file, opens_at)
      SELECT id, ?, ? FROM editorial_items WHERE id = ? AND revision = ? AND published IS ?
    `).bind(file, opensAt, id, revision, payload)),
  ]);
  return result[0].meta.changes ? deploy(env) : bad('发布状态已变化，请重新打开后再试。', 409);
}

export async function exportEditorial(db) {
  const { results } = await db.prepare(`
    SELECT id, kind, published, published_revision, published_at FROM editorial_items
    WHERE published IS NOT NULL ORDER BY published_at DESC, id
  `).all();
  return {
    editorialEditions: results.filter((row) => row.kind === 'edition')
      .map((row) => ({ ...JSON.parse(row.published), revision: row.published_revision })),
    articles: results.filter((row) => row.kind === 'article')
      .map((row) => ({ ...JSON.parse(row.published), id: row.id, publishedAt: row.published_at })),
  };
}

export async function publishingResponse(env, path, input) {
  if (path === '/api/editor/items') {
    const { results } = await env.DB.prepare('SELECT * FROM editorial_items ORDER BY rowid DESC').all();
    return [{ items: results.map(view) }, 200];
  }
  if (path.endsWith('/save')) return save(env.DB, input);
  if (path.endsWith('/deploy')) return deploy(env);
  return publish(env, input, path.endsWith('/withdraw'));
}
