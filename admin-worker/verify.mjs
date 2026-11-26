// Run with Node 24. SQLite exercises the Worker migration and queries.
// External GitHub, Pages and Cloudflare asset bindings are substituted here only.
import assert from 'node:assert/strict';
import { timingSafeEqual, generateKeyPairSync, createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
const publicRoot = new URL('../', import.meta.url).pathname;
const pdfs = Object.fromEntries(['paper', 'solutions'].map((kind) => [
  kind, readFileSync(join(publicRoot, 'resources', kind + '.pdf')),
]));
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
let servedPapers = {};
let catalog = [];
let head = 'base';
let pendingTree;
let rejectRefUpdate = false;
let updatedRefs = 0;
const blobs = new Map();
const repositoryFiles = new Map();
globalThis.fetch = async (url, options) => {
  if (url.endsWith('/access_tokens')) {
    const { repositories, permissions } = JSON.parse(options.body);
    assert.deepEqual(repositories, ['AvePhO']);
    assert.equal(options.headers.authorization.split('.').length, 3);
    if (permissions.actions) {
      assert.deepEqual(permissions, { actions: 'write' });
      return Response.json({ token: 'installation-token' });
    }
    assert.ok(['read', 'write'].includes(permissions.contents));
    assert.deepEqual(Object.keys(permissions), ['contents']);
    return Response.json({ token: 'contents-' + permissions.contents });
  }
  if (url.endsWith('/dispatches')) {
    assert.deepEqual(JSON.parse(options.body), { ref: 'main' });
    assert.equal(options.headers.authorization, 'Bearer installation-token');
    return failDispatch ? new Response(null, { status: 403 }) :
      Response.json({ html_url: 'https://github.com/ChihayaAnonQyan/AvePhO/actions/runs/77' });
  }
  if (url.startsWith('https://chihayaanonqyan.github.io/AvePhO/release.json?')) {
    return Response.json({ releaseId: servedRelease, paperRevisions: servedPapers });
  }
  const prefix = 'https://api.github.com/repos/ChihayaAnonQyan/AvePhO';
  if (url.startsWith(prefix)) {
    const path = url.slice(prefix.length);
    const bearer = options.headers.authorization;
    if (path === '/git/ref/heads/main') {
      assert.match(bearer, /^Bearer contents-(read|write)$/);
      return Response.json({ object: { sha: head } });
    }
    if (path === '/contents/src/papers.json?ref=' + head) {
      assert.match(bearer, /^Bearer contents-(read|write)$/);
      assert.equal(options.headers.accept, 'application/vnd.github.raw+json');
      return Response.json(catalog);
    }
    assert.equal(bearer, 'Bearer contents-write');
    if (path === '/git/commits/' + head) return Response.json({ tree: { sha: head + '-tree' } });
    const body = JSON.parse(options.body instanceof Blob ? await options.body.text() : options.body);
    if (path === '/git/blobs') {
      assert.equal(body.encoding, 'base64');
      const bytes = Buffer.from(body.content, 'base64');
      const sha = createHash('sha1').update(bytes).digest('hex');
      blobs.set(sha, bytes);
      return Response.json({ sha });
    }
    if (path === '/git/trees') {
      assert.equal(body.base_tree, head + '-tree');
      pendingTree = body.tree;
      return Response.json({ sha: 'new-tree' });
    }
    if (path === '/git/commits') {
      assert.deepEqual(body.parents, [head]);
      assert.equal(body.tree, 'new-tree');
      return Response.json({ sha: head + '-new' });
    }
    if (path === '/git/refs/heads/main') {
      assert.equal(options.method, 'PATCH');
      assert.deepEqual(body, { sha: head + '-new', force: false });
      if (rejectRefUpdate) return new Response(null, { status: 422 });
      for (const entry of pendingTree) {
        if (entry.path === 'src/papers.json') catalog = JSON.parse(entry.content);
        else repositoryFiles.set(entry.path, blobs.get(entry.sha));
      }
      head = body.sha;
      updatedRefs++;
      return Response.json({ object: { sha: head } });
    }
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
const paperList = () => request('/api/papers', { headers: auth }).then((r) => r.json());
const newPaperForm = (files, previous = '', revision = crypto.randomUUID()) => {
  const form = new FormData();
  for (const [key, value] of Object.entries({ number: '2', year: '2030', previous, revision })) form.set(key, value);
  for (const [kind, value] of Object.entries(files)) {
    form.set(kind, new Blob([value], { type: 'application/pdf' }), kind + '.pdf');
    form.set(kind + 'Version', 'v1.0');
  }
  return form;
};
const publishPapers = (body, headers = { ...auth, origin: env.ADMIN_ORIGIN }) =>
  request('/api/papers/publish', { method: 'POST', body, headers });
const firstPaper = newPaperForm({ paper: pdfs.paper });
assert.equal((await publishPapers(firstPaper, { origin: env.ADMIN_ORIGIN })).status, 401);
assert.equal((await publishPapers(firstPaper, { ...auth, origin: 'https://other.test' })).status, 403);
assert.equal((await publishPapers(newPaperForm({ paper: '<html>' }))).status, 400);
assert.equal((await publishPapers(newPaperForm({ paper: new Uint8Array(10 * 1024 * 1024 + 1) }))).status, 400);
assert.equal((await publishPapers(newPaperForm({ solutions: pdfs.solutions }))).status, 400);
rejectRefUpdate = true;
assert.equal((await publishPapers(firstPaper)).status, 409);
assert.deepEqual(await paperList(), { editions: [] });
assert.equal(repositoryFiles.size, 0);
rejectRefUpdate = false;
failDispatch = true;
const stored = await publishPapers(firstPaper);
assert.equal(stored.status, 502);
assert.match((await stored.json()).error, /已存入 GitHub/);
assert.equal((await paperList()).editions[0].state, 'pending');
assert.equal(updatedRefs, 1);
assert.deepEqual(repositoryFiles.get('resources/editions/2/paper.pdf'), pdfs.paper);
assert.equal(repositoryFiles.has('resources/editions/2/solutions.pdf'), false);
const paperOnly = { catalog: JSON.stringify(catalog), files: new Map(repositoryFiles) };
failDispatch = false;
assert.equal((await post('papers/retry', {})).status, 202);
assert.equal((await publishPapers(firstPaper)).status, 202);
assert.equal(updatedRefs, 1);
servedPapers = { 2: firstPaper.get('revision') };
assert.equal((await paperList()).editions[0].state, 'live');
assert.equal((await publishPapers(newPaperForm({ paper: pdfs.paper }))).status, 409);
const solutionsForm = newPaperForm({ solutions: pdfs.solutions }, firstPaper.get('revision'));
assert.equal((await publishPapers(solutionsForm)).status, 202);
assert.equal(updatedRefs, 2);
assert.deepEqual(repositoryFiles.get('resources/editions/2/paper.pdf'), pdfs.paper);
assert.deepEqual(repositoryFiles.get('resources/editions/2/solutions.pdf'), pdfs.solutions);
assert.equal((await paperList()).editions[0].state, 'pending');
servedPapers = { 2: solutionsForm.get('revision') };
assert.equal((await paperList()).editions[0].state, 'live');
const bothPdfs = { catalog: JSON.stringify(catalog), files: new Map(repositoryFiles) };
assert.equal((await post('logout', {})).status, 303);
assert.equal((await request('/api/announcements', { headers: auth })).status, 401);

const temp = mkdtempSync(join(tmpdir(), 'avepho-check-'));
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
  const checkout = join(temp, 'checkout');
  const checkoutResources = join(checkout, 'resources');
  mkdirSync(checkout);
  for (const directory of ['src', 'assets']) {
    cpSync(join(publicRoot, directory), join(checkout, directory), { recursive: true });
  }
  mkdirSync(join(checkoutResources, 'editions', '2'), { recursive: true });
  for (const file of ['paper.pdf', 'solutions.pdf', '2026.zip']) {
    cpSync(join(publicRoot, 'resources', file), join(checkoutResources, file));
  }
  for (const [name, stage] of Object.entries({ paperOnly, bothPdfs })) {
    writeFileSync(join(checkout, 'src', 'papers.json'), stage.catalog);
    for (const [path, bytes] of stage.files) writeFileSync(join(checkout, path), bytes);
    const build = join(temp, name);
    for (const program of ['src/build.py', 'src/verify.py']) {
      const result = spawnSync('python3', [program, '--output', build], { cwd: checkout, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    for (const locale of ['', 'zh-TW', 'en', 'ja']) {
      const detail = readFileSync(join(build, locale, 'edition-2.html'), 'utf8');
      const index = readFileSync(join(build, locale, 'papers.html'), 'utf8');
      assert.match(index, /edition-2\.html/);
      assert.match(index, /edition-2026\.html/);
      assert.match(detail, /2030/);
      assert.match(detail, /editions\/2\/paper\.pdf/);
      assert.equal(detail.includes('editions/2/solutions.pdf'), name === 'bothPdfs');
    }
    for (const [path, bytes] of stage.files) assert.deepEqual(readFileSync(join(build, path)), bytes);
    const marker = JSON.parse(readFileSync(join(build, 'release.json'), 'utf8'));
    assert.equal(marker.paperRevisions[2], JSON.parse(stage.catalog)[0].revision);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log('Login, authorization, draft persistence, public export, retry, publish and withdrawal verified locally.');
console.log('Paper upload, ref conflicts, deploy retries, adding solutions, four locales and original PDF bytes verified locally.');
