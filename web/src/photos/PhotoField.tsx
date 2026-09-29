import { useRef, useState } from 'react';
import { messageOf, type ApiClient } from '../api/client';
import type { ExpenseView } from '../api/types';
import { Close } from '../components/icons';
import { Banner } from '../components/ui';
import { PhotoImage } from './PhotoImage';
import { PhotoViewer } from './Photos';
import { shrinkPhoto } from './shrink';

type Photo = { key: number; id?: number; blob?: Blob; busy?: boolean };

/** Held in the form until create succeeds; edits upload and remove immediately. */
export function usePhotoField(client: ApiClient, expense?: ExpenseView) {
  const [photos, setPhotos] = useState<Photo[]>(() => expense?.photos.map(photo => ({ key: photo.id, id: photo.id })) ?? []);
  const [working, setWorking] = useState(false);
  const lock = useRef(false);
  const sequence = useRef(-1);
  const [error, setError] = useState<string | null>(null);
  async function add(file: File) {
    if (lock.current || photos.length >= 3) return;
    lock.current = true; setWorking(true); setError(null);
    const key = sequence.current--;
    setPhotos(current => [...current, { key, blob: file, busy: true }]);
    try {
      const blob = await shrinkPhoto(file);
      setPhotos(current => current.map(p => p.key === key ? { key, blob, busy: Boolean(expense) } : p));
      if (expense) {
        const saved = await client.uploadPhoto(expense.id, blob);
        setPhotos(current => current.map(p => p.key === key ? { key, id: saved.id } : p));
      }
    } catch (problem) {
      setPhotos(current => current.filter(p => p.key !== key));
      setError(messageOf(problem));
    } finally { lock.current = false; setWorking(false); }
  }
  async function remove(photo: Photo) {
    if (lock.current) return;
    lock.current = true; setWorking(true); setError(null);
    try {
      if (photo.id !== undefined) await client.removePhoto(photo.id);
      setPhotos(current => current.filter(p => p.key !== photo.key));
    } catch (problem) { setError(messageOf(problem)); }
    finally { lock.current = false; setWorking(false); }
  }
  async function uploadAfterSave(expenseId: number): Promise<Blob[]> {
    const failed: Blob[] = [];
    for (const photo of photos) {
      if (!photo.blob || photo.id !== undefined) continue;
      setPhotos(current => current.map(p => p.key === photo.key ? { ...p, busy: true } : p));
      try {
        const saved = await client.uploadPhoto(expenseId, photo.blob);
        setPhotos(current => current.map(p => p.key === photo.key ? { key: p.key, id: saved.id } : p));
      } catch {
        failed.push(photo.blob);
        setPhotos(current => current.map(p => p.key === photo.key ? { ...p, busy: false } : p));
      }
    }
    return failed;
  }
  return { photos, working, error, add, remove, uploadAfterSave };
}

export function PhotoField({ client, field, expense, disabled }: { client: ApiClient; field: ReturnType<typeof usePhotoField>; expense?: ExpenseView; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const receipt = expense?.hasReceiptPhoto ? { source: `/api/expenses/${expense.id}/receipt-photo`, label: 'Receipt' } : null;
  return <section className="field" aria-labelledby="photos-label">
    <span className="field-label" id="photos-label">Photos</span>
    {field.error ? <Banner kind="error">{field.error}</Banner> : null}
    <div className="photo-row">
      {receipt ? <div className="photo-tile">
        <PhotoImage client={client} source={receipt.source} alt="Receipt" />
        <button type="button" className="photo-open" aria-label="Open Receipt" onClick={() => setReceiptOpen(true)} />
        <span className="photo-label">Receipt</span>
      </div> : null}
      {field.photos.map(photo => <div className="photo-tile" key={photo.key}>
        <PhotoImage client={client} source={photo.id !== undefined ? `/api/photos/${photo.id}` : photo.blob!} alt="Expense photo" />
        {photo.busy ? <span className="photo-upload" role="status" aria-label="Preparing or uploading photo"><span className="photo-spinner" /></span> : null}
        <button type="button" className="photo-remove" aria-label="Remove photo" disabled={disabled || field.working} onClick={() => void field.remove(photo)}><Close size={18} /></button>
      </div>)}
      {field.photos.length < 3 ? <button type="button" className="photo-tile photo-add" disabled={disabled || field.working} onClick={() => input.current?.click()}>Add photo</button> : null}
    </div>
    <input ref={input} className="visually-hidden" type="file" accept="image/*" aria-label="Choose photo" disabled={disabled || field.working || field.photos.length >= 3} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (file) void field.add(file);
    }} />
    {receiptOpen && receipt ? <PhotoViewer client={client} photos={[receipt]} initialIndex={0} onClose={() => setReceiptOpen(false)} /> : null}
  </section>;
}
