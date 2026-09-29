import { Api } from 'grammy';
import type { Hono } from 'hono';
import { addExpensePhoto, assertExpensePhotosWritable, getExpense, getExpensePhoto, inTransaction, listExpensePhotos, NotFoundError, removeExpensePhoto, ValidationError } from '../../db/index.js';
import { createTelegramDownloader } from '../../receipts/download.js';
import { idParam, type ApiContext, type ApiEnv, type Services } from '../context.js';
import { MAX_PHOTO_BYTES, PhotoError, photoEtag, PhotoStore, readLimited, receiptKey, shrinkPhoto } from '../photos.js';

function imageResponse(c: ApiContext, data: Buffer): Response {
  const etag = photoEtag(data);
  c.header('Cache-Control', 'private, max-age=86400');
  c.header('Vary', 'Authorization, X-Launch');
  c.header('ETag', etag);
  if ((c.req.header('If-None-Match') ?? '').split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*')) return c.body(null, 304);
  c.header('Content-Type', 'image/jpeg');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(new Uint8Array(data));
}

export function registerPhotoRoutes(app: Hono<ApiEnv>, { config, db, deps }: Services): void {
  const store = new PhotoStore(config.photoDir);
  const download = deps.downloadPhoto ?? createTelegramDownloader(new Api(config.botToken), config.botToken);
  // Coalesce simultaneous receipt views, and use disk again after process restarts.
  const pending = new Map<string, Promise<Buffer>>();

  app.post('/api/expenses/:id/photos', async c => {
    const scope = c.get('caller').scope;
    const expenseId = idParam(c, 'id', 'expense');
    assertExpensePhotosWritable(db, scope, expenseId);
    if (listExpensePhotos(db, scope, expenseId).length >= 3) throw new ValidationError('photo_limit', 'An expense can have at most 3 photos. Remove a photo before adding another.');
    // Allow a small multipart envelope beyond the image limit. Stream counting also covers chunked requests.
    const body = await readLimited(c.req.raw.body, MAX_PHOTO_BYTES + 64 * 1024, c.req.header('Content-Length'));
    let form: FormData;
    try { form = await new Response(new Uint8Array(body), { headers: { 'Content-Type': c.req.header('Content-Type') ?? '' } }).formData(); }
    catch { throw new PhotoError(400, 'Choose a photo to upload.'); }
    const photo = form.get('photo');
    if (!(photo instanceof File)) throw new PhotoError(400, 'Choose a photo to upload.');
    if (photo.size > MAX_PHOTO_BYTES) throw new PhotoError(413, 'Photos must be 10 MB or smaller.');
    const { data, info } = await shrinkPhoto(new Uint8Array(await photo.arrayBuffer()));
    const key = store.write(scope.groupId, data);
    try {
      const record = addExpensePhoto(db, scope, expenseId, { fileKey: key, width: info.width, height: info.height, bytes: data.length });
      return c.json(record, 201);
    } catch (error) {
      store.remove(scope.groupId, key);
      throw error;
    }
  });

  app.get('/api/photos/:id', c => {
    const scope = c.get('caller').scope;
    const photo = getExpensePhoto(db, scope, idParam(c, 'id', 'photo'));
    const data = store.read(scope.groupId, photo.fileKey);
    if (!data) throw new NotFoundError('photo', photo.id);
    return imageResponse(c, data);
  });

  app.delete('/api/photos/:id', c => {
    const scope = c.get('caller').scope;
    inTransaction(db, () => {
      const photo = removeExpensePhoto(db, scope, idParam(c, 'id', 'photo'));
      store.remove(scope.groupId, photo.fileKey);
    });
    return c.body(null, 204);
  });

  app.get('/api/expenses/:id/receipt-photo', async c => {
    const scope = c.get('caller').scope;
    const expense = getExpense(db, scope, idParam(c, 'id', 'expense'));
    if (!expense.receiptFileId) throw new NotFoundError('receipt photo', expense.id);
    const key = receiptKey(expense.receiptFileId);
    let data = store.read(scope.groupId, key);
    if (!data) {
      const cacheId = `${scope.groupId}/${key}`;
      let job = pending.get(cacheId);
      if (!job) {
        const fileId = expense.receiptFileId;
        job = (async () => {
          let shrunk;
          try { shrunk = await shrinkPhoto(await download(fileId)); }
          // Telegram errors can contain the token. Neither log nor propagate them.
          catch { throw new NotFoundError('receipt photo', expense.id); }
          store.write(scope.groupId, shrunk.data, key);
          return shrunk.data;
        })();
        pending.set(cacheId, job);
      }
      try { data = await job; }
      finally { if (pending.get(cacheId) === job) pending.delete(cacheId); }
    }
    return imageResponse(c, data);
  });
}
