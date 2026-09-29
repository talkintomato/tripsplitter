/** Decode with orientation, then re-encode without EXIF (including GPS). */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  let source: ImageBitmap | HTMLImageElement;
  let release = () => {};
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const bitmap = source;
    release = () => bitmap.close();
  } catch {
    const url = URL.createObjectURL(file);
    const img = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Could not decode photo'));
        img.src = url;
      });
    } finally { URL.revokeObjectURL(url); }
    source = img;
  }
  try {
    const width = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
    const height = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
    if (!width || !height) throw new Error('Empty image');
    const scale = Math.min(1, 1600 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode photo')), 'image/jpeg', 0.8));
  } finally { release(); }
}
