import { useEffect, useRef, type RefObject } from 'react';

/** How far from the left edge a swipe back has to start, in pixels. */
const EDGE = 32;
/** How far the page must travel, as a share of its width, for letting go to go back. */
const DISTANCE = 0.35;
/** A flick this fast, in pixels per millisecond, goes back however far it travelled. */
const FLICK = 0.5;
const SETTLE_MS = 220;

/**
 * Swipe from the left edge to go back, as in Safari: the page follows the finger, and letting go
 * past a third of the way (or with a flick) slides it off and goes back; otherwise it slides home.
 * Only a swipe that is more across than down counts, so scrolling is untouched.
 */
export function useSwipeBack(ref: RefObject<HTMLElement | null>, onBack: (() => void) | null): void {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const enabled = onBack !== null;

  useEffect(() => {
    const page = ref.current;
    if (!enabled || !page) return undefined;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastT = 0;
    let speed = 0;
    let state: 'idle' | 'pending' | 'dragging' = 'idle';

    const place = (x: number, animate: boolean): void => {
      page.style.transition = animate && !reduced ? `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : 'none';
      page.style.transform = x === 0 ? '' : `translate3d(${x}px, 0, 0)`;
      page.style.boxShadow = x === 0 ? '' : '-8px 0 24px rgba(0, 0, 0, 0.18)';
    };

    const reset = (): void => {
      page.style.transition = '';
      page.style.transform = '';
      page.style.boxShadow = '';
      page.style.willChange = '';
    };

    const onStart = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || touch.clientX > EDGE) return;
      startX = lastX = touch.clientX;
      startY = touch.clientY;
      lastT = event.timeStamp;
      speed = 0;
      state = 'pending';
    };

    const onMove = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (state === 'idle' || !touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (state === 'pending') {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (dx <= 0 || Math.abs(dy) > dx) {
          state = 'idle';
          return;
        }
        state = 'dragging';
        page.style.willChange = 'transform';
      }
      event.preventDefault();
      const elapsed = event.timeStamp - lastT;
      if (elapsed > 0) speed = (touch.clientX - lastX) / elapsed;
      lastX = touch.clientX;
      lastT = event.timeStamp;
      place(Math.max(0, dx), false);
    };

    const onEnd = (): void => {
      if (state !== 'dragging') {
        state = 'idle';
        return;
      }
      state = 'idle';
      const width = page.getBoundingClientRect().width || window.innerWidth;
      const travelled = lastX - startX;
      const goBack = travelled > width * DISTANCE || (speed > FLICK && travelled > 24);
      if (!goBack) {
        place(0, true);
        window.setTimeout(reset, SETTLE_MS);
        return;
      }
      place(window.innerWidth, true);
      window.setTimeout(() => {
        onBackRef.current?.();
        // The same element may show the next page, so put it back once that page is in.
        requestAnimationFrame(reset);
      }, reduced ? 0 : SETTLE_MS);
    };

    page.addEventListener('touchstart', onStart, { passive: true });
    page.addEventListener('touchmove', onMove, { passive: false });
    page.addEventListener('touchend', onEnd);
    page.addEventListener('touchcancel', onEnd);
    return () => {
      page.removeEventListener('touchstart', onStart);
      page.removeEventListener('touchmove', onMove);
      page.removeEventListener('touchend', onEnd);
      page.removeEventListener('touchcancel', onEnd);
      reset();
    };
  }, [ref, enabled]);
}
