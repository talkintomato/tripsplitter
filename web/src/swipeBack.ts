import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/** How far from the left edge a swipe back has to start, in pixels. */
const EDGE = 32;
/** How far the page must travel, as a share of its width, for letting go to go back. */
const DISTANCE = 0.35;
/** A flick this fast, in pixels per millisecond, goes back however far it travelled. */
const FLICK = 0.5;
const SETTLE_MS = 220;
/** How far left the page underneath starts, as a share of the width, and how dark. */
const UNDER_OFFSET = 0.3;
const UNDER_DIM = 0.12;

/**
 * A picture of each page further back, so a swipe can show the page it returns to.
 * The router keeps one page on screen, so when a page is left its elements are copied here:
 * pushed when going forward, dropped when going back, kept when one page replaces another.
 */
interface Snapshot { node: HTMLElement; scrollY: number }
/** One entry per page further back; null where no picture could be taken. */
const behind: (Snapshot | null)[] = [];
let leaving: Snapshot | null = null;
let lastKey: string | null = null;
let backByReplace = false;

/** Call just before a way back that replaces the page rather than stepping back. */
export function markBackByReplace(): void {
  backByReplace = true;
}

/**
 * Keeps the pictures in step with the router. `page` is this page's element; its copy is taken as it
 * goes, and the page it returns to is scrolled to where it was.
 */
export function usePageHistory(page: RefObject<HTMLElement | null>): void {
  const location = useLocation();
  const type = useNavigationType();
  const scrollY = useRef(0);

  useEffect(() => {
    const track = (): void => { scrollY.current = window.scrollY; };
    track();
    window.addEventListener('scroll', track, { passive: true });
    return () => window.removeEventListener('scroll', track);
  }, []);

  // Taken as the page unmounts, while its elements are still whole.
  useLayoutEffect(() => {
    const el = page.current;
    return () => {
      if (el) leaving = { node: el.cloneNode(true) as HTMLElement, scrollY: scrollY.current };
    };
  }, [page]);

  useLayoutEffect(() => {
    if (location.key === lastKey) return;
    const first = lastKey === null;
    lastKey = location.key;
    const left = leaving;
    leaving = null;
    if (first) return;
    if (type === 'PUSH') {
      behind.push(left);
    } else if (type === 'POP' || backByReplace) {
      const back = behind.pop();
      if (back && back.scrollY > 0) restoreScroll(back.scrollY);
    }
    backByReplace = false;
  }, [location.key, type]);
}

/** Back to where the page was, once it has loaded enough to be that long. */
function restoreScroll(y: number): void {
  let tries = 0;
  const attempt = (): void => {
    window.scrollTo(0, y);
    if (Math.abs(window.scrollY - y) > 2 && ++tries < 20) window.setTimeout(attempt, 50);
  };
  requestAnimationFrame(attempt);
}

/** The picture of the page a swipe returns to, laid behind the current page. */
function showUnder(): { move(progress: number, animate: boolean): void; remove(): void } | null {
  const snap = behind.at(-1);
  if (!snap) return null;
  const layer = document.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  layer.inert = true;
  Object.assign(layer.style, {
    position: 'fixed', inset: '0', zIndex: '0', overflow: 'hidden', pointerEvents: 'none', background: 'var(--bg)',
  });
  const copy = snap.node.cloneNode(true) as HTMLElement;
  copy.style.transform = `translate3d(0, ${-snap.scrollY}px, 0)`;
  // The bar stays at the top of the screen, as it did while the page was scrolled.
  const bar = copy.querySelector<HTMLElement>(':scope > .bar');
  if (bar) Object.assign(bar.style, { position: 'relative', transform: `translate3d(0, ${snap.scrollY}px, 0)` });
  const dim = document.createElement('div');
  Object.assign(dim.style, { position: 'absolute', inset: '0', background: '#000', opacity: String(UNDER_DIM) });
  layer.append(copy, dim);
  document.body.append(layer);
  const width = window.innerWidth;
  const move = (progress: number, animate: boolean): void => {
    const transition = animate ? `${SETTLE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : 'none';
    layer.style.transition = animate ? `transform ${transition}` : 'none';
    layer.style.transform = `translate3d(${-(1 - progress) * width * UNDER_OFFSET}px, 0, 0)`;
    dim.style.transition = animate ? `opacity ${transition}` : 'none';
    dim.style.opacity = String((1 - progress) * UNDER_DIM);
  };
  move(0, false);
  return { move, remove: () => layer.remove() };
}

/**
 * Swipe from the left edge to go back, as in Safari: the page follows the finger with the page it
 * returns to sliding in underneath, and letting go past a third of the way (or with a flick) slides
 * it off and goes back; otherwise it slides home. Only a swipe more across than down counts, so
 * scrolling is untouched.
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
    let state: 'idle' | 'pending' | 'dragging' | 'settling' = 'idle';
    let under: ReturnType<typeof showUnder> = null;

    const place = (x: number, animate: boolean): void => {
      page.style.transition = animate && !reduced ? `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : 'none';
      page.style.transform = x === 0 ? '' : `translate3d(${x}px, 0, 0)`;
      page.style.boxShadow = x === 0 ? '' : '-8px 0 24px rgba(0, 0, 0, 0.18)';
      under?.move(Math.min(1, x / window.innerWidth), animate && !reduced);
    };

    const reset = (): void => {
      for (const key of ['transition', 'transform', 'boxShadow', 'willChange', 'position', 'zIndex', 'background', 'minHeight'] as const) {
        page.style[key] = '';
      }
      under?.remove();
      under = null;
      state = 'idle';
    };

    const onStart = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (state !== 'idle' || event.touches.length !== 1 || !touch || touch.clientX > EDGE) return;
      startX = lastX = touch.clientX;
      startY = touch.clientY;
      lastT = event.timeStamp;
      speed = 0;
      state = 'pending';
    };

    const onMove = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if ((state !== 'pending' && state !== 'dragging') || !touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (state === 'pending') {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (dx <= 0 || Math.abs(dy) > dx) {
          state = 'idle';
          return;
        }
        state = 'dragging';
        // The page covers the one underneath while it moves.
        Object.assign(page.style, { willChange: 'transform', position: 'relative', zIndex: '1', background: 'var(--bg)', minHeight: '100dvh' });
        under = showUnder();
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
        if (state === 'pending') state = 'idle';
        return;
      }
      state = 'settling';
      const width = page.getBoundingClientRect().width || window.innerWidth;
      const travelled = lastX - startX;
      const goBack = travelled > width * DISTANCE || (speed > FLICK && travelled > 24);
      if (!goBack) {
        place(0, true);
        window.setTimeout(reset, reduced ? 0 : SETTLE_MS);
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
