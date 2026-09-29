import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export class PhotoError extends Error {
  constructor(readonly status: 400 | 413 | 415, message: string) { super(message); }
}

/** Bound both declared and streamed bodies, including requests without Content-Length. */
export async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number, length?: string | null): Promise<Buffer> {
  if (Number(length) > limit) throw new PhotoError(413, 'Photos must be 10 MB or smaller.');
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new PhotoError(413, 'Photos must be 10 MB or smaller.');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export async function shrinkPhoto(bytes: Uint8Array) {
  try {
    return await sharp(bytes)
      .rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true });
  } catch {
    throw new PhotoError(415, 'That file could not be read as an image. Choose another photo.');
  }
}

/** Keys are generated here or read from our database; never use a request path or filename. */
export class PhotoStore {
  constructor(private readonly root: string) { mkdirSync(root, { recursive: true }); }
  private path(groupId: number, key: string): string {
    if (!Number.isSafeInteger(groupId) || groupId <= 0 || !/^[a-zA-Z0-9-]+\.jpg$/.test(key)) throw new Error('Invalid stored photo key');
    return join(this.root, String(groupId), key);
  }
  write(groupId: number, bytes: Buffer, key = `${randomUUID()}.jpg`): string {
    mkdirSync(join(this.root, String(groupId)), { recursive: true });
    const path = this.path(groupId, key);
    const temporary = this.path(groupId, `${randomUUID()}.jpg`);
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return key;
  }
  read(groupId: number, key: string): Buffer | null {
    try { return readFileSync(this.path(groupId, key)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  remove(groupId: number, key: string): void {
    try { unlinkSync(this.path(groupId, key)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export function receiptKey(fileId: string): string {
  return `receipt-${createHash('sha256').update(fileId).digest('hex')}.jpg`;
}
export function photoEtag(data: Buffer): string {
  return `"${createHash('sha256').update(data).digest('hex')}"`;
}
