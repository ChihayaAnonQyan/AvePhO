import { commitPapers, dispatchPages, GitHubError, openPaperCatalog } from './github.mjs';

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_FORM_BYTES = 2 * MAX_PDF_BYTES + 32 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const KINDS = ['paper', 'solutions'];

class FormError extends Error {}

async function readForm(request) {
  const type = request.headers.get('content-type');
  if (!type?.startsWith('multipart/form-data;') || !request.body) {
    throw new FormError('请选择要上传的 PDF。');
  }
  const tooLarge = '每份 PDF 最多 10 MiB。';
  if (Number(request.headers.get('content-length')) > MAX_FORM_BYTES) throw new FormError(tooLarge);
  let total = 0;
  const stream = request.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > MAX_FORM_BYTES) throw new FormError(tooLarge);
      controller.enqueue(chunk);
    },
  }));
  try {
    return await new Response(stream, { headers: { 'content-type': type } }).formData();
  } catch {
    throw new FormError(total > MAX_FORM_BYTES ? tooLarge : '无法读取上传表单，请重新选择 PDF。');
  }
}

async function readPublication(request) {
  const form = await readForm(request);
  const number = Number(form.get('number'));
  const year = Number(form.get('year'));
  const revision = form.get('revision');
  const previous = form.get('previous');
  if (!Number.isInteger(number) || number < 2 || number > 999) throw new FormError('届次须在 2 至 999 之间。');
  if (!Number.isInteger(year) || year < 2026 || year > 9999) throw new FormError('请填写实际举办年份。');
  if (typeof revision !== 'string' || !UUID.test(revision) ||
      typeof previous !== 'string' || (previous && !UUID.test(previous))) throw new FormError('请刷新后重新提交。');
  const files = new Map();
  const versions = {};
  const decoder = new TextDecoder();
  for (const kind of KINDS) {
    const file = form.get(kind);
    if (!(file instanceof File) || !file.name) continue;
    if (file.size > MAX_PDF_BYTES) throw new FormError('每份 PDF 最多 10 MiB。');
    const header = decoder.decode(await file.slice(0, 8).arrayBuffer());
    const trailer = decoder.decode(await file.slice(-1024).arrayBuffer());
    if (!/^%PDF-\d\.\d$/.test(header) || !/%%EOF[\x00\t\n\f\r ]*$/.test(trailer)) {
      throw new FormError('请选择有效的 PDF 文件。');
    }
    const version = form.get(kind + 'Version');
    if (typeof version !== 'string' || !version.trim() || version.trim().length > 32 || /[\x00-\x1f\x7f]/.test(version)) {
      throw new FormError('请为每份上传的 PDF 填写版本，最多 32 字。');
    }
    files.set(kind, file);
    versions[kind] = version.trim();
  }
  if (!files.size) throw new FormError('请至少选择一份 PDF。');
  return { number, year, revision, previous, files, versions };
}

async function listPapers(env, site) {
  const { editions } = await openPaperCatalog(env);
  let live = null;
  try {
    const response = await fetch(`${site}release.json?papers=${Date.now()}`, {
      cache: 'no-store', redirect: 'error',
    });
    if (response.ok) live = (await response.json()).paperRevisions ?? {};
  } catch {
    // GitHub still has the source catalog when Pages cannot be reached.
  }
  return { editions: editions.map((item) => ({
    ...item, state: live === null ? 'unknown' : live[item.number] === item.revision ? 'live' : 'pending',
  })) };
}

async function publishPapers(request, env) {
  const { number, year, revision, previous, files, versions } = await readPublication(request);
  const catalog = await openPaperCatalog(env, 'write');
  const current = catalog.editions.find((entry) => entry.number === number);
  if (current?.revision !== revision) {
    if ((current?.revision ?? '') !== previous) {
      return [{ error: '这届的资料有更新，请刷新列表后再提交。' }, 409];
    }
    if (!current && !files.has('paper')) throw new FormError('发布新一届时，请上传理论试题 PDF。');
    if (current && current.year !== year) throw new FormError('补传资料时请保留该届的原举办年份。');
    const entry = { number, year, revision, files: { ...current?.files, ...versions } };
    const editions = [...catalog.editions.filter((item) => item.number !== number), entry]
      .sort((a, b) => a.number - b.number);
    await commitPapers(catalog, editions, number, files);
  }
  return deployPapers(env);
}

async function deployPapers(env) {
  try {
    return [{ runUrl: await dispatchPages(env) }, 202];
  } catch {
    return [{ error: '试卷已存入 GitHub，暂时无法确认部署已启动。可点「重试部署」。' }, 502];
  }
}

export async function paperResponse(request, env, site, path) {
  try {
    if (path === '/api/papers') return [await listPapers(env, site), 200];
    if (path === '/api/papers/retry') return deployPapers(env);
    return await publishPapers(request, env);
  } catch (error) {
    if (error instanceof FormError) return [{ error: error.message }, 400];
    if (error instanceof GitHubError && error.operation === '/git/refs/heads/main') {
      return [{ error: 'GitHub 未接受发布。请核对 main 分支是否允许 GitHub App 写入，再刷新试卷列表。' }, 409];
    }
    if (error instanceof GitHubError && error.operation.startsWith('/contents/') && error.status === 404) {
      return [{ error: '请先将试卷管理更新合并到 GitHub 的 main 分支。' }, 503];
    }
    if (error instanceof GitHubError && [401, 403, 422].includes(error.status)) {
      return [{ error: 'GitHub 拒绝访问，请核对 App 的 Contents 权限和安装范围。' }, 502];
    }
    return [{ error: '暂时无法确认操作结果。请刷新试卷列表后重试。' }, 502];
  }
}
