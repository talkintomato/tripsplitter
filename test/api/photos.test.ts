import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../src/api/index.js';
import { createConsoleNotifier } from '../../src/api/dev-server.js';
import { MAX_PHOTO_BYTES } from '../../src/api/photos.js';
import { buildConfig } from '../../src/config.js';
import { encodeLaunch } from '../../src/core/index.js';
import { createExpense, deleteExpense, discardExpense, endTrip, getExpense, listActivity, listExpensePhotos, restoreExpense, type ExpensePhoto } from '../../src/db/index.js';
import { dinner, seedTwo } from '../db/helpers.js';

describe('expense photos', () => {
  let seed: ReturnType<typeof seedTwo>;
  let dir: string;
  let app: ReturnType<typeof createApi>;
  let expenseId: number;
  let small: Buffer;
  const download = vi.fn<(id: string) => Promise<Uint8Array>>();
  const makeApp = () => createApi(buildConfig({ photoDir: dir, nodeEnv: 'development', devFakeUser: { id: 101, firstName: 'Member' } }), seed.db, {
    notifier: createConsoleNotifier(() => {}), suggestRate: async () => null, downloadPhoto: download,
  });
  function headers(other = false) {
    const group = (other ? seed.b : seed.a).group;
    return { Authorization: 'tma dev', 'X-Launch': encodeLaunch({ groupId: group.id, linkVersion: group.linkVersion, view: 'home' }, buildConfig().linkSecret) };
  }
  async function upload(bytes = small, id = expenseId) {
    const form = new FormData();
    form.append('photo', new Blob([new Uint8Array(bytes)]), 'ignored-name.png');
    return app.request(`/api/expenses/${id}/photos`, { method: 'POST', headers: headers(), body: form });
  }
  const get = (path: string, other = false) => app.request(path, { headers: headers(other) });
  const remove = (id: number, other = false) => app.request(`/api/photos/${id}`, { method: 'DELETE', headers: headers(other) });
  const saved = async () => (await (await upload()).json()) as ExpensePhoto;

  beforeEach(async () => {
    seed = seedTwo();
    // The same signed-in Telegram user can legitimately open both group launches.
    seed.db.prepare('UPDATE member SET telegram_user_id = 101 WHERE id = ?').run(seed.b.ana.id);
    mkdirSync('data', { recursive: true });
    dir = mkdtempSync('data/photo-test-');
    app = makeApp();
    expenseId = createExpense(seed.db, seed.a.asAna, dinner(seed.a)).id;
    small = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#123456' } }).png().toBuffer();
    download.mockReset();
  });
  afterEach(() => { seed.db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('stores an oriented, shrunk JPEG without EXIF, and serves authenticated cached bytes', async () => {
    const large = await sharp({ create: { width: 3200, height: 2000, channels: 3, background: '#123456' } })
      .withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect((await sharp(large).metadata()).exif).toBeDefined();
    const response = await upload(large);
    expect(response.status).toBe(201);
    const photo = await response.json() as ExpensePhoto;
    expect(photo).toMatchObject({ expenseId, groupId: seed.a.group.id, width: 1000, height: 1600, addedByMemberId: seed.a.ana.id });
    const bytes = readFileSync(join(dir, String(seed.a.group.id), photo.fileKey));
    const meta = await sharp(bytes).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1000, height: 1600 });
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(photo.bytes).toBe(bytes.length);
    const image = await get(`/api/photos/${photo.id}`);
    expect(image.headers.get('Content-Type')).toBe('image/jpeg');
    expect(image.headers.get('Cache-Control')).toBe('private, max-age=86400');
    expect(image.headers.get('ETag')).toMatch(/^"[a-f0-9]{64}"$/);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes);
    const unchanged = await app.request(`/api/photos/${photo.id}`, { headers: { ...headers(), 'If-None-Match': image.headers.get('ETag')! } });
    expect(unchanged.status).toBe(304);
    expect((await app.request(`/api/photos/${photo.id}`)).status).toBe(401);
  });

  it('rejects non-images and oversized images and bodies before decoding', async () => {
    expect((await upload(Buffer.from('not an image'))).status).toBe(415);
    expect((await upload(Buffer.alloc(MAX_PHOTO_BYTES + 1))).status).toBe(413);
    expect((await app.request(`/api/expenses/${expenseId}/photos`, { method: 'POST', headers: { ...headers(), 'Content-Length': String(MAX_PHOTO_BYTES + 100_000) }, body: 'small' })).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); } });
    const request = new Request(`http://localhost/api/expenses/${expenseId}/photos`, { method: 'POST', headers: headers(), body: stream, duplex: 'half' } as RequestInit);
    expect((await app.fetch(request)).status).toBe(413);
    expect(listExpensePhotos(seed.db, seed.a.asAna, expenseId)).toEqual([]);
  });

  it('limits concurrent uploads to three without leaving extra files', async () => {
    const responses = await Promise.all([upload(), upload(), upload(), upload()]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 201, 201, 409]);
    const refused = responses.find(r => r.status === 409)!;
    expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(/at most 3 photos/);
    expect(readdirSync(join(dir, String(seed.a.group.id)))).toHaveLength(3);
  });

  it('keeps every route group scoped, including conditional requests', async () => {
    const photo = await saved();
    expect((await get(`/api/photos/${photo.id}`, true)).status).toBe(404);
    expect((await remove(photo.id, true)).status).toBe(404);
    expect((await get(`/api/expenses/${expenseId}/receipt-photo`, true)).status).toBe(404);
    const otherExpense = createExpense(seed.db, seed.b.asAna, dinner(seed.b));
    expect((await upload(small, otherExpense.id)).status).toBe(404);
    expect((await app.request(`/api/photos/${photo.id}`, { headers: { ...headers(true), 'If-None-Match': '*' } })).status).toBe(404);
  });

  it.each(['ended', 'deleted', 'discarded'] as const)('refuses changes when %s, retaining rows and files', async state => {
    if (state === 'discarded') expenseId = createExpense(seed.db, seed.a.asAna, dinner(seed.a, { status: 'draft' })).id;
    const photo = await saved();
    if (state === 'ended') endTrip(seed.db, seed.a.asAna, seed.a.trip.id);
    else if (state === 'deleted') deleteExpense(seed.db, seed.a.asAna, expenseId, 1);
    else discardExpense(seed.db, seed.a.asAna, expenseId, 1);
    expect((await upload()).status).toBe(400);
    expect((await remove(photo.id)).status).toBe(400);
    expect((await get(`/api/photos/${photo.id}`)).status).toBe(200);
    if (state !== 'ended') {
      const removed = getExpense(seed.db, seed.a.asAna, expenseId);
      restoreExpense(seed.db, seed.a.asAna, expenseId, removed.version);
      expect(listExpensePhotos(seed.db, seed.a.asAna, expenseId)).toEqual([photo]);
    }
  });

  it('removes the row and file, logs both actions immutably, and returns expense photo fields', async () => {
    const photo = await saved();
    const response = await (await get(`/api/expenses/${expenseId}`)).json() as { expense: unknown };
    expect(response.expense).toMatchObject({ photos: [{ id: photo.id, width: 80, height: 40 }], hasReceiptPhoto: false, version: 1 });
    expect((await remove(photo.id)).status).toBe(204);
    expect(existsSync(join(dir, String(seed.a.group.id), photo.fileKey))).toBe(false);
    expect(listExpensePhotos(seed.db, seed.a.asAna, expenseId)).toEqual([]);
    expect((await get(`/api/photos/${photo.id}`)).status).toBe(404);
    const activity = listActivity(seed.db, seed.a.asAna, { entity: { type: 'expense', id: expenseId } });
    expect(activity.slice(0, 2).map(a => a.action)).toEqual(['expense.photo_removed', 'expense.photo_added']);
    expect(activity[0]).toMatchObject({ groupId: seed.a.group.id, tripId: seed.a.trip.id, actor: seed.a.asAna.actor, before: { photoId: photo.id }, after: null });
    expect(() => seed.db.prepare('DELETE FROM activity WHERE id = ?').run(activity[0]!.id)).toThrow(/cannot be removed/);
  });

  it('fetches a receipt once across simultaneous views and a new API instance', async () => {
    const receipt = createExpense(seed.db, seed.a.asAna, dinner(seed.a, { receiptFileId: 'stored-file', status: 'draft' }));
    download.mockResolvedValue(small);
    const path = `/api/expenses/${receipt.id}/receipt-photo`;
    const responses = await Promise.all([get(path), get(path)]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    app = makeApp();
    expect((await get(path)).status).toBe(200);
    expect(download).toHaveBeenCalledExactlyOnceWith('stored-file');
    expect((await sharp(Buffer.from(await responses[0]!.arrayBuffer())).metadata()).format).toBe('jpeg');
    expect(((await (await get(`/api/expenses/${receipt.id}`)).json()) as { expense: unknown }).expense).toMatchObject({ photos: [], hasReceiptPhoto: true });
  });

  it('returns 404 for missing or unavailable receipts without logging download errors', async () => {
    expect((await get(`/api/expenses/${expenseId}/receipt-photo`)).status).toBe(404);
    expect(download).not.toHaveBeenCalled();
    const receipt = createExpense(seed.db, seed.a.asAna, dinner(seed.a, { receiptFileId: 'missing' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      download.mockRejectedValue(new Error('private download failure'));
      expect((await get(`/api/expenses/${receipt.id}/receipt-photo`)).status).toBe(404);
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
