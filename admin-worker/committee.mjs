import initialRoster from '../src/committee.json' with { type: 'json' };
import { dispatchPages } from './github.mjs';
import { pinyin } from './vendor/pinyin-pro.mjs';

const rosterRow = (db) => db.prepare('SELECT * FROM committee_roster WHERE id = 1').first();
const error = (message, status) => [{ error: message }, status];
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function nickname(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  return name.length <= 120 && !/[\x00-\x1f\x7f]/.test(name) ? name : '';
}

function cleanRoster(draft) {
  if (!Array.isArray(draft?.editionTeams) || !Array.isArray(draft?.members)) return null;
  const seen = new Set();
  const editionTeams = [];
  for (const team of draft.editionTeams) {
    const { number, members } = team ?? {};
    if (!Number.isInteger(number) || number < 1 || number > 999 || seen.has(number) ||
        !Array.isArray(members) || !members.length) return null;
    const names = members.map(nickname);
    if (names.some((name) => !name)) return null;
    seen.add(number);
    editionTeams.push({ number, members: names });
  }
  const members = [];
  for (const item of draft.members) {
    const name = nickname(item?.name);
    if (!name || typeof item.bio !== 'string' || !item.bio.trim()) return null;
    members.push({ name, bio: item.bio.trim() });
  }
  return { editionTeams: editionTeams.sort((a, b) => b.number - a.number), members };
}

function view(row) {
  return {
    revision: row.revision,
    publishedRevision: row.published_revision,
    draft: row.draft ? JSON.parse(row.draft) : initialRoster,
  };
}

function publishedPayload(draft) {
  const members = draft.members.map((member) => ({
    member,
    key: pinyin(member.name, { type: 'array', toneType: 'none' }).join(''),
  }));
  members.sort((a, b) => collator.compare(a.key, b.key));
  return { ...draft, members: members.map(({ member }) => member) };
}

export async function exportedCommittee(db) {
  const row = await rosterRow(db);
  return row.published ? { ...JSON.parse(row.published), revision: row.published_revision } : null;
}

export async function committeeResponse(env, command, input, publicSite) {
  const db = env.DB;
  const row = await rosterRow(db);
  if (command === 'read') return [view(row), 200];
  if (command === 'check') {
    if (row.published_revision === null) return [{ live: false }, 200];
    try {
      const url = new URL('release.json', publicSite);
      url.searchParams.set('committee', row.published_revision);
      url.searchParams.set('check', Date.now());
      const response = await fetch(url.href, { cache: 'no-store', redirect: 'error' });
      const marker = response.ok ? await response.json() : null;
      return [{ live: marker?.committeeRevision === row.published_revision }, 200];
    } catch {
      return error('暂时无法读取官网的发布记录，请稍后再核对。', 502);
    }
  }

  if (!Number.isInteger(input?.revision)) return error('请检查名单或刷新后再试。', 400);
  if (command === 'save') {
    const draft = cleanRoster(input.draft);
    if (!draft) return error('请检查届次是否重复、名单是否为空，以及委员的昵称和简介。', 400);
    const payload = JSON.stringify(draft);
    if (row.revision === input.revision + 1 && row.draft === payload) return [view(row), 200];
    const result = await db.prepare(`
      UPDATE committee_roster SET draft = ?, revision = revision + 1 WHERE id = 1 AND revision = ?
    `).bind(payload, input.revision).run();
    return result.meta.changes ? [view(await rosterRow(db)), 200] : error('名单草稿已有更新，请刷新后再编辑。', 409);
  }

  if (!row.draft || row.revision !== input.revision) return error('请保存最新草稿后再发布。', 409);
  if (row.published_revision !== row.revision) {
    const payload = JSON.stringify(publishedPayload(JSON.parse(row.draft)));
    const result = await db.prepare(`
      UPDATE committee_roster SET published = ?, published_revision = revision WHERE id = 1 AND revision = ?
    `).bind(payload, input.revision).run();
    if (!result.meta.changes) return error('名单草稿已有更新，请刷新后再发布。', 409);
  }
  const state = view(await rosterRow(db));
  try {
    return [{ state, runUrl: await dispatchPages(env), deployed: true }, 202];
  } catch {
    return [{ state, runUrl: null, deployed: false }, 202];
  }
}
