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

export async function dispatchPages(env) {
  const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(env.GITHUB_INSTALLATION_ID)}/access_tokens`, {
    method: 'POST',
    redirect: 'error',
    headers: githubHeaders(await appJwt(env)),
    body: JSON.stringify({ repositories: ['AvePhO'], permissions: { actions: 'write' } }),
  });
  if (!response.ok) throw new Error('Cannot obtain GitHub installation token');
  const { token } = await response.json();
  const dispatch = await fetch(`${REPO}/actions/workflows/pages.yml/dispatches`, {
    method: 'POST', redirect: 'error', headers: githubHeaders(token),
    body: JSON.stringify({ ref: 'main' }),
  });
  if (!dispatch.ok) throw new Error('GitHub did not accept deployment');
  if (dispatch.status === 204) return null;
  const { html_url: url } = await dispatch.json();
  return typeof url === 'string' &&
    /^https:\/\/github\.com\/ChihayaAnonQyan\/AvePhO\/actions\/runs\/\d+$/.test(url) ? url : null;
}
