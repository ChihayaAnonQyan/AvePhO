import { base64url, dispatchPages, sha256 } from './github.mjs';

const SITE = 'https://chihayaanonqyan.github.io/AvePhO/';
const SESSION = '__Host-avepho-session';
const SESSION_AGE = 8 * 3600;
const MAX_PENDING_POST = 20 * 1024;
const headers = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
const json = (body, status = 200) => Response.json(body, { status, headers });
const fail = (message, status) => json({ error: message }, status);
const time = () => Math.floor(Date.now() / 1000);
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const cookie = (name, value, age) => `${name}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}`;

function readCookie(request, name) {
  return (request.headers.get('cookie') || '').split(/;\s*/).find((pair) => pair.startsWith(name + '='))?.slice(name.length + 1);
}

function redirect(location, ...cookies) {
  const response = new Response(null, { status: 303, headers: { ...headers, location } });
  for (const value of cookies) response.headers.append('set-cookie', value);
  return response;
}

function configuredPassword(env) {
  return /^[A-Za-z0-9_-]{43}$/.test(env.ADMIN_PASSWORD_SHA256 ?? '');
}

function sessionHash(env, token) {
  return sha256(`password:v1:${env.ADMIN_PASSWORD_SHA256}:${token}`);
}

async function logIn(request, env) {
  if (request.headers.get('origin') !== env.ADMIN_ORIGIN) return fail('请求来源无效。', 403);
  if (!configuredPassword(env) || !env.LOGIN_LIMIT) return fail('管理员密码尚未配置。', 503);
  const address = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await env.LOGIN_LIMIT.limit({ key: address });
  if (!success) {
    return Response.json({ error: '尝试次数较多，请一分钟后再试。' }, {
      status: 429, headers: { ...headers, 'retry-after': '60' },
    });
  }
  const input = await readInput(request, 2048);
  if (typeof input?.password !== 'string' || !input.password || input.password.length > 256) {
    return fail('请输入密码。', 400);
  }
  const encoder = new TextEncoder();
  if (!crypto.subtle.timingSafeEqual(
    encoder.encode(await sha256(input.password)), encoder.encode(env.ADMIN_PASSWORD_SHA256),
  )) return fail('密码不正确。', 401);

  const token = random();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(time()),
    env.DB.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)')
      .bind(await sessionHash(env, token), time() + SESSION_AGE),
  ]);
  const response = json({ signedIn: true });
  response.headers.set('set-cookie', cookie(SESSION, token, SESSION_AGE));
  return response;
}

async function readInput(request, limit = MAX_PENDING_POST) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return null;
  if (Number(request.headers.get('content-length')) > limit || !request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let input = '';
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) { await reader.cancel(); return null; }
    input += decoder.decode(value, { stream: true });
  }
  try { return JSON.parse(input + decoder.decode()); } catch { return null; }
}

function validDraft(data) {
  return typeof data?.title === 'string' && data.title.trim().length > 0 && data.title.length <= 120 &&
    typeof data.body === 'string' && data.body.trim().length > 0 && data.body.length <= 5000;
}

const newest = (db) => db.prepare(
  'SELECT * FROM releases ORDER BY rowid DESC LIMIT 1'
).first();
const fromSnapshot = (row) => row ? JSON.parse(row.snapshot) : [];
const releaseView = (row) => row && ({ id: row.id, state: row.state, runUrl: row.run_url, action: row.action });

async function exportRelease(request, env) {
  const token = request.headers.get('authorization');
  if (!env.EXPORT_SECRET || !token || token.length > 256 ||
      !crypto.subtle.timingSafeEqual(
        new TextEncoder().encode(await sha256(token)),
        new TextEncoder().encode(await sha256('Bearer ' + env.EXPORT_SECRET)))) return fail('访问受限。', 401);
  const release = await newest(env.DB);
  return json({ releaseId: release?.id ?? null, announcements: fromSnapshot(release) });
}

async function trigger(env, release) {
  try {
    const runUrl = await dispatchPages(env);
    await env.DB.prepare('UPDATE releases SET run_url = ? WHERE id = ?').bind(runUrl, release.id).run();
    return json({ release: { ...releaseView(release), runUrl } }, 202);
  } catch {
    return json({ error: '发布记录已保存，GitHub 构建尚未确认。可在后台重试。', release: releaseView(release) }, 502);
  }
}

async function checkLive(env) {
  const release = await newest(env.DB);
  if (release?.state !== 'pending') return json({ release: releaseView(release) });
  try {
    const response = await fetch(`${SITE}release.json?release=${release.id}&check=${Date.now()}`, {
      cache: 'no-store', redirect: 'error',
    });
    const marker = response.ok ? await response.json() : null;
    if (marker?.releaseId === release.id) {
      await env.DB.prepare("UPDATE releases SET state = 'live', checked_at = ? WHERE id = ? AND state = 'pending'")
        .bind(new Date().toISOString(), release.id).run();
      release.state = 'live';
    }
  } catch {
    return fail('暂时无法核对官网，请稍后再检查。', 502);
  }
  return json({ release: releaseView(release) });
}

async function queueRelease(db, id, revision, action) {
  const releaseId = crypto.randomUUID();
  const created = new Date().toISOString();
  const current = await newest(db);
  if (current?.state === 'pending') return null;
  const item = await db.prepare('SELECT * FROM announcements WHERE id = ? AND revision = ?').bind(id, revision).first();
  if (!item) return null;
  const prior = fromSnapshot(current);
  const published = prior.find((row) => row.id === id);
  if (action === 'withdraw' && !published) return null;
  const entries = prior.filter((row) => row.id !== id);
  if (action === 'publish') {
    entries.push({
      id, title: item.title, body: item.body, revision,
      publishedAt: published?.publishedAt ?? created,
    });
  }
  if (entries.length > 100 || JSON.stringify(entries).length > 200000) return null;
  // Confirm the draft revision and base release still match at insertion time.
  const saved = await db.prepare(`
    INSERT OR IGNORE INTO releases (id, state, announcement_id, action, snapshot, created_at)
    SELECT ?, 'pending', ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM announcements WHERE id = ? AND revision = ?)
      AND COALESCE((SELECT id FROM releases ORDER BY rowid DESC LIMIT 1), '') = ?
  `).bind(releaseId, id, action, JSON.stringify(entries), created, id, revision, current?.id ?? '').run();
  return saved.meta.changes ? { id: releaseId, state: 'pending', action } : null;
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (url.origin !== env.ADMIN_ORIGIN) return fail('请使用配置的后台网址。', 404);
  const { pathname: path } = url;
  const { method } = request;
  if (method === 'POST' && path === '/auth/login') return logIn(request, env);
  if (method === 'GET' && path === '/internal/release') return exportRelease(request, env);
  if (method === 'GET' && ['/', '/admin.js', '/admin.css'].includes(path)) {
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  }
  if (!path.startsWith('/api/')) return fail('找不到该页面。', 404);
  const token = readCookie(request, SESSION);
  if (!configuredPassword(env) || !/^[\w-]{43}$/.test(token || '')) return fail('请先登录。', 401);
  const tokenHash = await sessionHash(env, token);
  const session = await env.DB.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(tokenHash, time()).first();
  if (!session) return fail('请重新输入密码登录。', 401);
  if (method === 'GET' && path === '/api/announcements') {
    const release = await newest(env.DB);
    const live = release?.state === 'pending'
      ? await env.DB.prepare("SELECT snapshot FROM releases WHERE state = 'live' ORDER BY rowid DESC LIMIT 1").first()
      : release;
    const { results: drafts } = await env.DB.prepare('SELECT * FROM announcements ORDER BY rowid DESC').all();
    const published = Object.fromEntries(fromSnapshot(live).map((item) => [item.id, item.revision]));
    return json({ drafts, published, release: releaseView(release) });
  }
  if (method !== 'POST') return fail('找不到该操作。', 404);
  if (request.headers.get('origin') !== env.ADMIN_ORIGIN) return fail('请求来源无效。', 403);
  if (path === '/api/logout') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return redirect('/', cookie(SESSION, '', 0));
  }
  if (path === '/api/check') return checkLive(env);
  if (path === '/api/retry') {
    const release = await newest(env.DB);
    return release?.state === 'pending' ? trigger(env, release) : fail('当前没有待上线的发布。', 409);
  }
  const payload = await readInput(request);
  if (path === '/api/save') {
    if (!validDraft(payload)) return fail('请填写标题和正文。标题最多 120 字，正文最多 5000 字。', 400);
    if (payload.id !== undefined && (typeof payload.id !== 'string' || !Number.isInteger(payload.revision))) {
      return fail('草稿版本无效，请刷新页面。', 400);
    }
    const title = payload.title.trim();
    const body = payload.body.trim();
    const id = payload.id ?? crypto.randomUUID();
    if (payload.id !== undefined) {
      const result = await env.DB.prepare('UPDATE announcements SET title = ?, body = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
        .bind(title, body, id, payload.revision ?? 0).run();
      if (!result.meta.changes) return fail('草稿已被修改，请刷新后重新编辑。', 409);
    } else {
      await env.DB.prepare('INSERT INTO announcements VALUES (?, ?, ?, 1)').bind(id, title, body).run();
    }
    return json({ id, title, body, revision: payload.id !== undefined ? payload.revision + 1 : 1 });
  }
  if (path === '/api/publish' || path === '/api/withdraw') {
    if (typeof payload?.id !== 'string' || !Number.isInteger(payload?.revision)) return fail('请先保存草稿。', 400);
    const release = await queueRelease(env.DB, payload.id, payload.revision, path.slice(5));
    return release ? trigger(env, release) : fail('当前无法发布。请检查是否已有发布在进行、版本是否变更或公告是否已发布。', 409);
  }
  return fail('找不到该操作。', 404);
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch { return fail('操作暂时无法完成，请刷新后重试。', 503); }
  },
};
