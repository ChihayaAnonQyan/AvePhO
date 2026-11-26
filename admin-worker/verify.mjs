// Run with Node 24. SQLite exercises the Worker migration and queries.
// External GitHub, Pages and Cloudflare asset bindings are substituted here only.
import assert from 'node:assert/strict';
import { timingSafeEqual, generateKeyPairSync, createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import handler from './worker.mjs';

crypto.subtle.timingSafeEqual = timingSafeEqual;
const database = new DatabaseSync(':memory:');
const migrate = (name) => database.exec(readFileSync(new URL('./migrations/' + name, import.meta.url), 'utf8'));
migrate('0001_announcements.sql');
database.exec("INSERT INTO sessions VALUES ('old-session', '1234', 9999999999)");
database.exec("INSERT INTO announcements VALUES ('migration-test', 'Existing draft', 'Example', 1)");
migrate('0002_password_sessions.sql');
assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
assert.equal(database.prepare('SELECT title FROM announcements WHERE id = ?').get('migration-test').title, 'Existing draft');
database.exec("DELETE FROM announcements WHERE id = 'migration-test'");
const DB = {
  prepare(sql) {
    const statement = database.prepare(sql);
    return { bind: (...values) => operations(values), ...operations([]) };
    function operations(params) {
      return {
        first: async () => statement.get(...params) ?? null,
        all: async () => ({ results: statement.all(...params) }),
        run: () => ({ meta: statement.run(...params) }),
      };
    }
  },
  async batch(operations) {
    database.exec('BEGIN');
    try {
      for (const operation of operations) operation.run();
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  },
};
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const password = 'test-password-for-local-integration';
const passwordHash = (value) => createHash('sha256').update(value).digest('base64url');
let loginAttempts = 0;
const env = {
  DB,
  ADMIN_ORIGIN: 'https://test.workers.dev',
  GITHUB_CLIENT_ID: 'test',
  ADMIN_PASSWORD_SHA256: passwordHash(password),
  LOGIN_LIMIT: {
    async limit({ key }) {
      assert.equal(key, '203.0.113.10');
      loginAttempts += 1;
      return { success: loginAttempts <= 5 };
    },
  },
  GITHUB_INSTALLATION_ID: '5678',
  GITHUB_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
  EXPORT_SECRET: 'test-secret',
};
let failDispatch = true;
let servedRelease = null;
globalThis.fetch = async (url, options) => {
  if (url.endsWith('/access_tokens')) {
    assert.deepEqual(JSON.parse(options.body), { repositories: ['AvePhO'], permissions: { actions: 'write' } });
    assert.equal(options.headers.authorization.split('.').length, 3);
    return Response.json({ token: 'installation-token' });
  }
  if (url.endsWith('/dispatches')) {
    assert.deepEqual(JSON.parse(options.body), { ref: 'main' });
    assert.equal(options.headers.authorization, 'Bearer installation-token');
    return failDispatch ? new Response(null, { status: 403 }) :
      Response.json({ html_url: 'https://github.com/ChihayaAnonQyan/AvePhO/actions/runs/77' });
  }
  if (url.startsWith('https://chihayaanonqyan.github.io/AvePhO/release.json?')) {
    return Response.json({ releaseId: servedRelease });
  }
  throw new Error('Unexpected test URL');
};
function request(path, options = {}) {
  return handler.fetch(new Request(env.ADMIN_ORIGIN + path, options), env);
}
function login(value, origin = env.ADMIN_ORIGIN) {
  return request('/auth/login', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.10' },
    body: JSON.stringify({ password: value }),
  });
}
assert.equal((await request('/api/announcements')).status, 401);
assert.equal((await request('/internal/release')).status, 401);
assert.equal((await request('/auth/callback?code=unused')).status, 404);
assert.equal((await login(password, 'https://other.test')).status, 403);
const verifier = env.ADMIN_PASSWORD_SHA256;
delete env.ADMIN_PASSWORD_SHA256;
assert.equal((await login(password)).status, 503);
env.ADMIN_PASSWORD_SHA256 = verifier;
for (let i = 0; i < 5; i++) assert.equal((await login('incorrect')).status, 401);
assert.equal((await login(password)).status, 429);
loginAttempts = 0;
const signedIn = await login(password);
assert.equal(signedIn.status, 200);
const sessionCookie = signedIn.headers.get('set-cookie');
assert.match(sessionCookie, /Secure; HttpOnly; SameSite=Lax/);
const session = sessionCookie.split(';')[0];

env.ADMIN_PASSWORD_SHA256 = passwordHash('rotated');
assert.equal((await request('/api/announcements', { headers: { cookie: session } })).status, 401);
env.ADMIN_PASSWORD_SHA256 = passwordHash(password);
const auth = { cookie: session };
const post = (path, data, origin = env.ADMIN_ORIGIN) => request('/api/' + path, {
  method: 'POST', headers: { ...auth, origin, 'content-type': 'application/json' },
  body: JSON.stringify(data),
});
const exported = () => request('/internal/release', {
  headers: { authorization: 'Bearer test-secret' },
}).then((response) => response.json());

assert.equal((await post('save', { title: 'X', body: 'Y' }, 'https://other.test')).status, 403);
const draft = await (await post('save', { title: '联调测试公告', body: '发布测试 <script>alert(1)</script>' })).json();
assert.equal(draft.revision, 1);
assert.equal((await request('/api/announcements', { headers: auth }).then((r) => r.json())).drafts[0].id, draft.id);
assert.deepEqual(await exported(), { releaseId: null, announcements: [] });
assert.equal((await post('save', { ...draft, revision: 0 })).status, 409);

assert.equal((await post('publish', draft)).status, 502);
const published = await exported();
assert.equal(published.announcements[0].title, draft.title);
assert.equal((await post('publish', draft)).status, 409);
failDispatch = false;
assert.equal((await post('retry', {})).status, 202);
assert.equal((await post('check', {}).then((r) => r.json())).release.state, 'pending');
servedRelease = published.releaseId;
assert.equal((await post('check', {}).then((r) => r.json())).release.state, 'live');

const changed = await (await post('save', { ...draft, title: '私有修订' })).json();
assert.equal((await exported()).announcements[0].title, draft.title);
assert.equal((await post('withdraw', changed)).status, 202);
const withdrawn = await exported();
assert.equal(withdrawn.announcements.length, 0);
servedRelease = withdrawn.releaseId;
assert.equal((await post('check', {}).then((r) => r.json())).release.state, 'live');
assert.equal((await post('logout', {})).status, 303);
assert.equal((await request('/api/announcements', { headers: auth })).status, 401);

const temp = mkdtempSync(join(tmpdir(), 'avepho-check-'));
const publicRoot = new URL('../', import.meta.url).pathname;
try {
  for (const [name, data] of Object.entries({ published, withdrawn })) {
    const file = join(temp, name + '.json');
    const build = join(temp, name);
    writeFileSync(file, JSON.stringify(data));
    const args = ['src/build.py', '--output', build, '--announcements', file, '--admin-url', env.ADMIN_ORIGIN];
    const run = (params) => {
      const result = spawnSync('python3', params, { cwd: publicRoot, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    run(args);
    console.log(run(['src/verify.py', '--output', build]));
    const notice = join(build, 'announcement-' + draft.id + '.html');
    assert.equal(existsSync(notice), name === 'published');
    const index = readFileSync(join(build, 'search-index.js'), 'utf8');
    assert.equal(index.includes(draft.title), name === 'published');
    assert.ok(!index.includes(changed.title));
    assert.equal(existsSync(join(build, 'admin-worker')), false);
    if (name === 'published') {
      const page = readFileSync(notice, 'utf8');
      assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
      assert.ok(!page.includes('<script>alert(1)</script>'));
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log('Login, authorization, draft persistence, public export, retry, publish and withdrawal verified locally.');
