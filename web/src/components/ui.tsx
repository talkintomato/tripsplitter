import { useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, messageOf } from '../api/client';
import { inTelegram, showBackButton } from '../telegram';

export function Screen(props: { title: string; subtitle?: string; back?: boolean | string; children: ReactNode }) {
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

  return (
    <main className="screen">
      <header className="screen-head">
        {back && !inTelegram() ? (
          <button type="button" className="back" onClick={goBack} aria-label="Back">
            ‹ Back
          </button>
        ) : null}
        <h1>{props.title}</h1>
        {props.subtitle ? <p className="hint">{props.subtitle}</p> : null}
      </header>
      {props.children}
    </main>
  );
}

export function Loading(props: { what?: string }) {
  return (
    <p className="state" role="status">
      Loading{props.what ? ` ${props.what}` : ''}…
    </p>
  );
}

export function ErrorState(props: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state" role="alert">
      <p>{messageOf(props.error)}</p>
      {props.onRetry ? (
        <button type="button" className="button" onClick={props.onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Empty(props: { children: ReactNode }) {
  return <p className="state hint">{props.children}</p>;
}

/** A coloured box above the content: something went wrong, or something to know. */
export function Banner(props: { kind?: 'error' | 'info' | 'warn'; children: ReactNode; onClose?: () => void }) {
  const kind = props.kind ?? 'info';
  return (
    <div className={`banner banner-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="banner-body">{props.children}</div>
      {props.onClose ? (
        <button type="button" className="banner-close" onClick={props.onClose} aria-label="Dismiss">
          ×
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

export function Section(props: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
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
    <div className="sheet-backdrop" onClick={props.onCancel}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={props.title} onClick={(event) => event.stopPropagation()}>
        <h2>{props.title}</h2>
        {props.children ? <div className="sheet-body">{props.children}</div> : null}
        <div className="sheet-actions">
          <button type="button" className={`button ${props.danger ? 'button-danger' : ''}`} disabled={props.busy} onClick={props.onConfirm}>
            {props.busy ? 'Working…' : props.confirmLabel}
          </button>
          <button type="button" className="button button-quiet" disabled={props.busy} onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
