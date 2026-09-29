import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ApiClient } from '../api/client';
import type { ExpenseView } from '../api/types';
import { ChevronLeft, ChevronRight, Close } from '../components/icons';
import { Section } from '../components/ui';
import { PhotoImage } from './PhotoImage';

export interface ViewPhoto { source: string; label: string }
export function expensePhotos(expense: ExpenseView): ViewPhoto[] {
  return [
    ...(expense.hasReceiptPhoto ? [{ source: `/api/expenses/${expense.id}/receipt-photo`, label: 'Receipt' }] : []),
    ...expense.photos.map((p, i) => ({ source: `/api/photos/${p.id}`, label: `Photo ${i + 1}` })),
  ];
}

export function Photos({ client, expense }: { client: ApiClient; expense: ExpenseView }) {
  const [index, setIndex] = useState<number | null>(null);
  const photos = expensePhotos(expense);
  if (!photos.length) return null;
  return <Section title="Photos">
    <div className="photo-row">
      {photos.map((photo, i) => <div className="photo-tile" key={photo.source}>
        <PhotoImage client={client} source={photo.source} alt={photo.label} />
        <button type="button" className="photo-open" aria-label={`Open ${photo.label}`} onClick={() => setIndex(i)} />
        {photo.label === 'Receipt' ? <span className="photo-label">Receipt</span> : null}
      </div>)}
    </div>
    {index !== null ? <PhotoViewer client={client} photos={photos} initialIndex={index} onClose={() => setIndex(null)} /> : null}
  </Section>;
}

export function PhotoViewer({ client, photos, initialIndex, onClose }: { client: ApiClient; photos: ViewPhoto[]; initialIndex: number; onClose(): void }) {
  const [index, setIndex] = useState(initialIndex);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const start = useRef<{ x: number; y: number } | null>(null);
  const move = (delta: number) => setIndex(i => (i + delta + photos.length) % photos.length);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const siblings = Array.from(document.body.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el !== dialog.current);
    const inert = siblings.map(el => el.inert);
    siblings.forEach(el => { el.inert = true; });
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      document.body.style.overflow = overflow;
      siblings.forEach((el, i) => { el.inert = inert[i]!; });
      before?.focus();
    };
  }, []);
  const photo = photos[index]!;
  // Native swipe-back handlers are on <main>. This portal is its sibling, never a descendant.
  return createPortal(<div ref={dialog} className="photo-viewer" role="dialog" aria-modal="true" aria-label="Photo viewer"
    onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); close.current(); }
      if (event.key === 'ArrowLeft') move(-1);
      if (event.key === 'ArrowRight') move(1);
      if (event.key === 'Tab') {
        const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const next = (buttons.indexOf(document.activeElement as HTMLButtonElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        event.preventDefault(); buttons[next]?.focus();
      }
    }}
    onTouchStart={event => { const t = event.touches[0]; start.current = event.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null; }}
    onTouchCancel={() => { start.current = null; }}
    onTouchEnd={event => {
      const t = event.changedTouches[0]; const from = start.current; start.current = null;
      if (t && from && Math.abs(t.clientX - from.x) > 45 && Math.abs(t.clientX - from.x) > Math.abs(t.clientY - from.y)) move(t.clientX < from.x ? 1 : -1);
    }}>
    <button type="button" className="photo-view-close" aria-label="Close photo viewer" onClick={onClose}><Close /></button>
    <div className="photo-view-image"><PhotoImage client={client} source={photo.source} alt={photo.label} /></div>
    <div className="photo-view-nav">
      {photos.length > 1 ? <button type="button" aria-label="Previous photo" onClick={() => move(-1)}><ChevronLeft /></button> : <span />}
      <span role="status">{photos.length > 1 ? `${photo.label} · ${index + 1} / ${photos.length}` : photo.label}</span>
      {photos.length > 1 ? <button type="button" aria-label="Next photo" onClick={() => move(1)}><ChevronRight /></button> : <span />}
    </div>
  </div>, document.body);
}
