import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ApiError, messageOf } from '../api/client';
import { inTelegram, showBackButton } from '../telegram';
import { Alert, ChevronLeft, ChevronRight, Close, Info, type IconComponent } from './icons';

/**
 * A page: a bar with the way back on the left, a centred title, and actions on the right.
 * `back`: true goes back one step, a path replaces the page with that path, false shows no way back.
 * Inside Telegram the way back is Telegram's own button, so the bar leaves its place empty.
 * `leading` replaces the way back, for a page that has something else to go to, such as All my groups.
 * `largeTitle`: the title is shown big, under the bar, instead of in it.
 */
export function Screen(props: {
  title: string;
  subtitle?: ReactNode;
  back?: boolean | string;
  leading?: ReactNode;
  actions?: ReactNode;
  largeTitle?: boolean;
  /** Something between the title and the page, such as a status badge. */
  titleExtra?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { back = true } = props;
  const goBack = (): void => {
    if (typeof back === 'string') navigate(back, { replace: true });
    else navigate(-1);
  };
  useEffect(() => {
    if (!back) return undefined;
    return showBackButton(goBack);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [back]);

  const leading = props.leading ?? (back && !inTelegram() ? (
    <button type="button" className="icon-btn" onClick={goBack} aria-label="Back">
      <ChevronLeft />
    </button>
  ) : null);

  return (
    <main className={`screen ${props.className ?? ''}`}>
      <header className={`bar ${props.largeTitle ? 'bar-plain' : ''}`}>
        <div className="bar-side">{leading}</div>
        {props.largeTitle ? <span /> : (
          <div className="bar-title">
            <h1>{props.title}</h1>
            {props.subtitle ? <p className="bar-sub">{props.subtitle}</p> : null}
          </div>
        )}
        <div className="bar-side bar-end">{props.actions}</div>
      </header>
      {props.largeTitle ? (
        <div className="large-title">
          <h1>{props.title}</h1>
          {props.subtitle ? <p className="large-sub">{props.subtitle}</p> : null}
          {props.titleExtra}
        </div>
      ) : props.titleExtra}
      {props.children}
    </main>
  );
}

/** A page outside the router, such as the error page before a trip has loaded. */
export function PlainPage(props: { title: string; leading?: ReactNode; children: ReactNode }) {
  return (
    <main className="screen">
      <header className="bar">
        <div className="bar-side">{props.leading}</div>
        <div className="bar-title">
          <h1>{props.title}</h1>
        </div>
        <div className="bar-side bar-end" />
      </header>
      {props.children}
    </main>
  );
}

export function IconButton(props: { label: string; icon: IconComponent; onClick(): void; disabled?: boolean; tone?: 'danger' }) {
  const Icon = props.icon;
  return (
    <button type="button" className={`icon-btn ${props.tone === 'danger' ? 'icon-btn-danger' : ''}`} aria-label={props.label} title={props.label} disabled={props.disabled} onClick={props.onClick}>
      <Icon />
    </button>
  );
}

/**
 * A skeleton of what is coming, in place of a spinner: grey shapes where the rows will be, with a slow shimmer.
 * `list` for lists of people or expenses, `detail` for one expense, `cards` for rows of cards such as groups.
 * Screen readers hear "Loading …" once.
 */
export function Loading(props: { what?: string; shape?: 'list' | 'detail' | 'cards'; rows?: number }) {
  const shape = props.shape ?? 'list';
  const rows = props.rows ?? (shape === 'cards' ? 3 : 5);
  return (
    <div className={`skeleton skeleton-${shape}`} role="status" aria-busy="true">
      <span className="visually-hidden">Loading{props.what ? ` ${props.what}` : ''}…</span>
      {shape === 'detail' ? (
        <div aria-hidden="true">
          <span className="sk sk-line" style={{ width: '45%' }} />
          <span className="sk sk-title" />
          <span className="sk sk-line" style={{ width: '35%' }} />
          <div className="sk-card">
            {Array.from({ length: 4 }, (_, i) => <SkeletonRow key={i} />)}
          </div>
        </div>
      ) : (
        <div className={shape === 'cards' ? 'sk-cards' : 'sk-card'} aria-hidden="true">
          {Array.from({ length: rows }, (_, i) => <SkeletonRow key={i} card={shape === 'cards'} />)}
        </div>
      )}
    </div>
  );
}

function SkeletonRow(props: { card?: boolean }) {
  return (
    <div className={`sk-row ${props.card ? 'sk-row-card' : ''}`}>
      <span className={`sk ${props.card ? 'sk-tile' : 'sk-circle'}`} />
      <span className="sk-lines">
        <span className="sk sk-line" style={{ width: '62%' }} />
        <span className="sk sk-line sk-line-sm" style={{ width: '38%' }} />
      </span>
      {props.card ? null : <span className="sk sk-amount" />}
    </div>
  );
}

export function ErrorState(props: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state" role="alert">
      <span className="state-icon state-icon-error" aria-hidden="true"><Alert size={22} /></span>
      <p>{messageOf(props.error)}</p>
      {props.onRetry ? (
        <button type="button" className="btn btn-secondary" onClick={props.onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Empty(props: { children: ReactNode; icon?: IconComponent; action?: ReactNode }) {
  const Icon = props.icon;
  return (
    <div className="state state-empty">
      {Icon ? <span className="state-icon" aria-hidden="true"><Icon size={22} /></span> : null}
      <p>{props.children}</p>
      {props.action}
    </div>
  );
}

/** A box above the content: something went wrong, something to check, or something to know. */
export function Banner(props: { kind?: 'error' | 'info' | 'warn' | 'success'; children: ReactNode; onClose?: () => void }) {
  const kind = props.kind ?? 'info';
  return (
    <div className={`banner banner-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span className="banner-icon" aria-hidden="true">{kind === 'info' || kind === 'success' ? <Info size={18} /> : <Alert size={18} />}</span>
      <div className="banner-body">{props.children}</div>
      {props.onClose ? (
        <button type="button" className="banner-close" onClick={props.onClose} aria-label="Dismiss">
          <Close size={16} />
        </button>
      ) : null}
    </div>
  );
}

/** What to show after a change was refused. A change made by someone else gets its own wording. */
export function ActionError(props: { error: unknown; onClose?: () => void }) {
  if (props.error === undefined || props.error === null) return null;
  const error = props.error;
  if (error instanceof ApiError && error.stale) {
    return (
      <Banner kind="warn" {...(props.onClose ? { onClose: props.onClose } : {})}>
        Someone else changed this just now. You are looking at the latest version. Check it and try again.
      </Banner>
    );
  }
  return (
    <Banner kind="error" {...(props.onClose ? { onClose: props.onClose } : {})}>
      {messageOf(error)}
    </Banner>
  );
}

export function Section(props: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`section ${props.className ?? ''}`}>
      {props.title || props.action ? (
        <div className="section-head">
          {props.title ? <h2>{props.title}</h2> : <span />}
          {props.action}
        </div>
      ) : null}
      {props.children}
    </section>
  );
}

/** A small tinted pill that says what state something is in. Always words, never colour alone. */
export function Badge(props: { tone: 'draft' | 'warn' | 'neutral' | 'neg' | 'pos'; children: ReactNode }) {
  return <span className={`badge badge-${props.tone}`}>{props.children}</span>;
}

/** Up to two letters for a name: "Mei Ling" is ML, "Sam" is SA. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? [...words[0]!].slice(0, 2) : [[...words[0]!][0], [...words[1]!][0]];
  return letters.join('').toUpperCase();
}

/**
 * A person's initials in a circle. The letters are drawn by CSS from a data attribute, so they are not part of
 * the text of the row, and a screen reader reads the name next to it once.
 */
/** Ten colours, in an order where neighbours differ, so members added one after another get contrasting colours. */
const AVATAR_ORDER = [0, 5, 2, 7, 4, 9, 1, 6, 3, 8];

/** A person's colour: fixed for a member for good, taken from their ID so it never changes when they are renamed. */
export function avatarColour(id: number | undefined, name: string): number {
  if (id !== undefined && Number.isSafeInteger(id) && id > 0) return AVATAR_ORDER[id % AVATAR_ORDER.length]!;
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return AVATAR_ORDER[hash % AVATAR_ORDER.length]!;
}

export function Avatar(props: { name: string; id?: number; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      className={`avatar avatar-${props.size ?? 'md'} avatar-c${avatarColour(props.id, props.name)}`}
      data-initials={initials(props.name)}
      aria-hidden="true"
    />
  );
}

/** A sheet that slides up from the bottom, over a dimmed page. Tapping outside or Escape closes it. */
export function Sheet(props: { label: string; onClose(): void; children: ReactNode; className?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    // Focus moves into the sheet, unless something in it asked for focus itself.
    if (panel.current && !panel.current.contains(document.activeElement)) panel.current.focus({ preventScroll: true });
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose.current();
    };
    document.addEventListener('keydown', key);
    document.body.classList.add('sheet-open');
    return () => {
      document.removeEventListener('keydown', key);
      document.body.classList.remove('sheet-open');
      before?.focus?.({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div
        ref={panel}
        className={`sheet ${props.className ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="sheet-handle" aria-hidden="true" />
        {props.children}
      </div>
    </div>,
    document.body,
  );
}

/** A question over the page, for changes that are hard to take back. */
export function Confirm(props: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Sheet label={props.title} onClose={() => { if (!props.busy) props.onCancel(); }}>
      <h2 className="sheet-title">{props.title}</h2>
      {props.children ? <div className="sheet-body">{props.children}</div> : null}
      <div className="sheet-actions">
        <button type="button" className={`btn btn-block ${props.danger ? 'btn-danger-solid' : 'btn-primary'}`} disabled={props.busy} onClick={props.onConfirm}>
          {props.busy ? 'Working…' : props.confirmLabel}
        </button>
        <button type="button" className="btn btn-block btn-secondary" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

/** One line of a menu in a sheet. */
export function MenuItem(props: { icon: IconComponent; label: string; hint?: string; onClick(): void; tone?: 'danger'; disabled?: boolean }) {
  const Icon = props.icon;
  return (
    <li>
      <button type="button" className={`menu-item ${props.tone === 'danger' ? 'menu-item-danger' : ''}`} onClick={props.onClick} disabled={props.disabled}>
        <span className="menu-icon" aria-hidden="true"><Icon /></span>
        <span className="menu-text">
          <span className="menu-label">{props.label}</span>
          {props.hint ? <span className="menu-hint">{props.hint}</span> : null}
        </span>
        <span className="menu-chevron" aria-hidden="true"><ChevronRight /></span>
      </button>
    </li>
  );
}

/**
 * Two or three choices side by side, one of them on. As tabs (`tablist`) it switches what the page shows;
 * as a `radiogroup` it is a choice in a form.
 */
export function Segmented<T extends string>(props: {
  label: string;
  role: 'tablist' | 'radiogroup';
  options: ReadonlyArray<{ value: T; label: ReactNode; disabled?: boolean; title?: string; controls?: string }>;
  value: T;
  onChange(value: T): void;
  className?: string;
}) {
  const tabs = props.role === 'tablist';
  return (
    <div className={`segmented ${props.className ?? ''}`} role={props.role} aria-label={props.label}>
      {props.options.map((option) => {
        const on = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            role={tabs ? 'tab' : 'radio'}
            {...(tabs ? { 'aria-selected': on, ...(option.controls ? { 'aria-controls': option.controls } : {}) } : { 'aria-checked': on })}
            className={on ? 'on' : ''}
            disabled={option.disabled}
            title={option.title}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** The way back to the list of groups, as the bar's back control. */
export function GroupsBack(props: { onClick(): void }) {
  return (
    <button type="button" className="back-link" onClick={props.onClick} aria-label="All my groups">
      <ChevronLeft size={20} />
      <span>Groups</span>
    </button>
  );
}
