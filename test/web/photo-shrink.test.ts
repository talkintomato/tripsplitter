// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { shrinkPhoto } from '../../web/src/photos/shrink';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([[3200, 2000, 1600, 1000], [40, 80, 40, 80]])('orients and re-encodes %s × %s without upscaling', async (width, height, outWidth, outHeight) => {
  const close = vi.fn();
  const decode = vi.fn().mockResolvedValue({ width, height, close });
  vi.stubGlobal('createImageBitmap', decode);
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  let dimensions: number[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type, quality) {
    dimensions = [this.width, this.height];
    expect(type).toBe('image/jpeg'); expect(quality).toBe(0.8);
    callback(new Blob(['jpeg'], { type }));
  });
  const file = new Blob(['original']);
  expect((await shrinkPhoto(file)).type).toBe('image/jpeg');
  expect(decode).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
  expect(dimensions).toEqual([outWidth, outHeight]);
  expect(drawImage).toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
});

it('falls back to an image when bitmap decoding is unavailable, revoking the temporary URL', async () => {
  vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported')));
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => 'blob:fallback');
    static override revokeObjectURL = vi.fn();
  });
  vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLImageElement) {
    Object.defineProperty(this, 'naturalWidth', { value: 100 });
    Object.defineProperty(this, 'naturalHeight', { value: 50 });
    queueMicrotask(() => this.dispatchEvent(new Event('load')));
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['jpeg'], { type: 'image/jpeg' })));
  expect((await shrinkPhoto(new Blob(['original']))).type).toBe('image/jpeg');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fallback');
});
