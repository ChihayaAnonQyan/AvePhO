import { Buffer } from 'node:buffer';

const REPO = 'https://api.github.com/repos/ChihayaAnonQyan/AvePhO';

export const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export async function sha256(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

function githubHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2026-03-10',
    'user-agent': 'AvePhO-Admin',
    'content-type': 'application/json',
  };
}

function der(tag, bytes) {
  const length = bytes.length;
  const size = length < 128 ? [length] : length < 256
    ? [0x81, length] : [0x82, length >> 8, length & 255];
  return Uint8Array.from([tag, ...size, ...bytes]);
}

function privateKeyBytes(pem) {
  const base64 = pem.replace(/-----[^-]+-----|\s/g, '');
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  if (!pem.includes('BEGIN RSA PRIVATE KEY')) return bytes;
  const version = [0x02, 0x01, 0x00];
  const rsaEncryption = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  return der(0x30, [...version, ...rsaEncryption, ...der(0x04, bytes)]);
}

async function appJwt(env) {
  const bytes = privateKeyBytes(env.GITHUB_PRIVATE_KEY);
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const key = await crypto.subtle.importKey('pkcs8', bytes, algorithm, false, ['sign']);
  const encode = (data) => base64url(new TextEncoder().encode(JSON.stringify(data)));
  const now = Math.floor(Date.now() / 1000);
  const message = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iat: now - 60, exp: now + 480, iss: env.GITHUB_CLIENT_ID,
  })}`;
  const signature = await crypto.subtle.sign(algorithm.name, key, new TextEncoder().encode(message));
  return `${message}.${base64url(new Uint8Array(signature))}`;
}

export class GitHubError extends Error {
  constructor(status, operation) {
    super(`GitHub rejected ${operation} (${status})`);
    this.status = status;
    this.operation = operation;
  }
}

async function installationToken(env, permissions) {
  const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(env.GITHUB_INSTALLATION_ID)}/access_tokens`, {
    method: 'POST',
    redirect: 'error',
    headers: githubHeaders(await appJwt(env)),
    body: JSON.stringify({ repositories: ['AvePhO'], permissions }),
  });
  if (!response.ok) throw new GitHubError(response.status, 'installation token');
  const { token } = await response.json();
  return token;
}

async function repoRequest(token, path, { method = 'GET', body, accept } = {}) {
  const headers = githubHeaders(token);
  if (accept) headers.accept = accept;
  const response = await fetch(REPO + path, {
    method, redirect: 'error', headers,
    body: body === undefined || body instanceof Blob ? body : JSON.stringify(body),
  });
  if (!response.ok) {
    // Release the response before attempting another GitHub request.
    await response.body?.cancel();
    throw new GitHubError(response.status, path);
  }
  return response;
}

export async function dispatchPages(env) {
  const token = await installationToken(env, { actions: 'write' });
  const dispatch = await repoRequest(token, '/actions/workflows/pages.yml/dispatches', {
    method: 'POST', body: { ref: 'main' },
  });
  if (dispatch.status === 204) return null;
  const { html_url: url } = await dispatch.json();
  return typeof url === 'string' &&
    /^https:\/\/github\.com\/ChihayaAnonQyan\/AvePhO\/actions\/runs\/\d+$/.test(url) ? url : null;
}

const CATALOG_PATH = 'src/papers.json';

export async function openPaperCatalog(env, access = 'read') {
  const token = await installationToken(env, { contents: access });
  const { object: { sha: head } } = await repoRequest(token, '/git/ref/heads/main').then((r) => r.json());
  const editions = await repoRequest(token, `/contents/${CATALOG_PATH}?ref=${head}`, {
    accept: 'application/vnd.github.raw+json',
  }).then((r) => r.json());
  return { token, head, editions };
}

export async function commitPapers({ token, head }, editions, number, files) {
  const { tree: { sha: baseTree } } = await repoRequest(token, `/git/commits/${head}`).then((r) => r.json());
  const entry = (path, data) => ({ path, mode: '100644', type: 'blob', ...data });
  const tree = [entry(CATALOG_PATH, { content: JSON.stringify(editions, null, 2) + '\n' })];
  for (const [kind, file] of files) {
    const content = Buffer.from(await file.arrayBuffer()).toString('base64');
    const { sha } = await repoRequest(token, '/git/blobs', {
      method: 'POST', body: new Blob(['{"encoding":"base64","content":"', content, '"}']),
    }).then((r) => r.json());
    tree.push(entry(`resources/editions/${number}/${kind}.pdf`, { sha }));
  }
  const { sha: newTree } = await repoRequest(token, '/git/trees', {
    method: 'POST', body: { base_tree: baseTree, tree },
  }).then((r) => r.json());
  const { sha } = await repoRequest(token, '/git/commits', {
    method: 'POST', body: { message: `Publish AvePhO edition ${number} resources`, tree: newTree, parents: [head] },
  }).then((r) => r.json());
  const updated = await repoRequest(token, '/git/refs/heads/main', {
    method: 'PATCH', body: { sha, force: false },
  });
  await updated.body?.cancel();
}

