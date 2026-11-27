import { Buffer } from 'node:buffer';

export const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const PDF = 'application/pdf';
export const IMAGES = ['image/png', 'image/jpeg', 'image/webp'];
const CHUNK_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const findAsset = (db, id) => db.prepare('SELECT * FROM editorial_assets WHERE id = ?').bind(id).first();
const isHeader = (mime, bytes) => {
  if (mime === PDF) return /^%PDF-\d\.\d/.test(bytes.subarray(0, 8).toString('ascii'));
  if (mime === 'image/jpeg') return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
};

async function boundedChunk(request, length) {
  if (!request.body || Number(request.headers.get('content-length')) > length) return null;
  const reader = request.body.getReader();
  const bytes = Buffer.alloc(length);
  let received = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) return received === length ? bytes : null;
    if (received + value.byteLength > length) {
      await reader.cancel();
      return null;
    }
    bytes.set(value, received);
    received += value.byteLength;
  }
}

export async function uploadChunk(request, db, query) {
  const id = query.get('id') || '';
  const size = Number(query.get('size'));
  const part = Number(query.get('part'));
  const mime = query.get('mime');
  const name = query.get('name') || '';
  const count = Math.ceil(size / CHUNK_BYTES);
  if (!UUID.test(id) || ![PDF, ...IMAGES].includes(mime) || !name.trim() ||
      name.length > 180 || /[\x00-\x1f\x7f/\\]/.test(name) ||
      !Number.isSafeInteger(size) || size < 8 || size > MAX_FILE_BYTES ||
      !Number.isInteger(part) || part < 0 || part >= count) {
    return [{ error: '请选择有效的 PDF、PNG、JPEG 或 WebP 文件，单份最多 10 MiB。' }, 400];
  }

  const existing = await findAsset(db, id);
  if (existing && (existing.size !== size || existing.mime !== mime || existing.name !== name)) {
    return [{ error: '上传信息已变化，请重新选择文件。' }, 409];
  }
  if (existing?.ready) return [{ id, name, ready: true }, 200];
  if (!existing && part !== 0) return [{ error: '请从第一段重新上传。' }, 409];

  const bytes = await boundedChunk(request, Math.min(CHUNK_BYTES, size - part * CHUNK_BYTES));
  if (!bytes || (!part && !isHeader(mime, bytes))) return [{ error: '文件格式或上传长度不正确。' }, 400];
  if (mime === PDF && part === count - 1) {
    let tail = bytes.subarray(-1024);
    if (tail.length < 1024 && part > 0) {
      const previous = await db.prepare('SELECT data FROM editorial_chunks WHERE asset = ? AND part = ?')
        .bind(id, part - 1).first();
      if (!previous) return [{ error: '请按顺序上传文件。' }, 409];
      tail = Buffer.concat([Buffer.from(previous.data, 'base64').subarray(-(1024 - tail.length)), tail]);
    }
    if (!/%%EOF[\x00\t\n\f\r ]*$/.test(tail.toString('ascii'))) {
      return [{ error: 'PDF 文件不完整。' }, 400];
    }
  }

  await db.batch([
    db.prepare('INSERT OR IGNORE INTO editorial_assets (id, mime, name, size) VALUES (?, ?, ?, ?)')
      .bind(id, mime, name, size),
    db.prepare(`
      INSERT OR IGNORE INTO editorial_chunks (asset, part, data)
      SELECT id, ?, ? FROM editorial_assets WHERE id = ? AND mime = ? AND name = ? AND size = ? AND ready = 0
    `).bind(part, bytes.toString('base64'), id, mime, name, size),
    db.prepare(`UPDATE editorial_assets SET ready = 1 WHERE id = ? AND ready = 0
      AND (SELECT COUNT(*) FROM editorial_chunks WHERE asset = ?) = ?`).bind(id, id, count),
  ]);
  const asset = await findAsset(db, id);
  return [{ id, name, ready: Boolean(asset?.ready) }, 200];
}

export async function allReady(db, files) {
  if (!files.size) return true;
  const ids = [...files.keys()];
  const { results } = await db.prepare(
    `SELECT id, mime FROM editorial_assets WHERE ready = 1 AND id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();
  return results.length === ids.length && results.every(({ id, mime }) => files.get(id).includes(mime));
}

export async function fileResponse(request, db, id, privatePreview = false) {
  if (!UUID.test(id)) return new Response(null, { status: 404 });
  const asset = privatePreview ? await findAsset(db, id) : await db.prepare(`
    SELECT a.* FROM editorial_assets a WHERE a.id = ? AND EXISTS (
      SELECT 1 FROM editorial_public_files p WHERE p.file = a.id AND p.opens_at <= ?
    )
  `).bind(id, Date.now()).first();
  if (!asset?.ready) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  const headers = {
    'content-type': asset.mime,
    'content-length': String(asset.size),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (asset.mime === PDF) {
    const name = encodeURIComponent(asset.name).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16));
    headers['content-disposition'] = `attachment; filename="AvePhO.pdf"; filename*=UTF-8''${name}`;
  }
  if (request.method === 'HEAD') return new Response(null, { headers });
  let part = 0;
  const count = Math.ceil(asset.size / CHUNK_BYTES);
  const stream = new ReadableStream({
    async pull(controller) {
      const row = await db.prepare('SELECT data FROM editorial_chunks WHERE asset = ? AND part = ?')
        .bind(id, part++).first();
      if (!row) return controller.error(new Error('Stored file is incomplete'));
      controller.enqueue(Buffer.from(row.data, 'base64'));
      if (part === count) controller.close();
    },
  });
  return new Response(stream, { headers });
}
