// The only file that talks to Telegram. Everything here also works in a normal browser,
// where there is no sign-in data and the start parameter comes from the address.
import WebApp from '@twa-dev/sdk';

/** The raw sign-in data to send with every request. Empty outside Telegram. */
export function getInitData(): string {
  try {
    return WebApp.initData ?? '';
  } catch {
    return '';
  }
}

export function inTelegram(): boolean {
  return getInitData() !== '';
}

/**
 * The start parameter of the group's link. Telegram passes it in the sign-in data and as
 * `tgWebAppStartParam`. In a browser, for development, `?startapp=` is read as well.
 */
export function getStartParam(): string | null {
  let fromTelegram: string | undefined;
  try {
    fromTelegram = WebApp.initDataUnsafe?.start_param;
  } catch {
    fromTelegram = undefined;
  }
  if (fromTelegram) return fromTelegram;
  const query = new URLSearchParams(window.location.search);
  return query.get('tgWebAppStartParam') || query.get('startapp') || null;
}

/** Tells Telegram the page is ready and asks for the full height. */
export function prepare(): void {
  try {
    WebApp.ready();
    WebApp.expand();
  } catch {
    // Not in Telegram.
  }
}

/** Shows Telegram's own back button while `handler` is set. Returns a function that removes it. */
export function showBackButton(handler: () => void): () => void {
  if (!inTelegram()) return () => {};
  try {
    WebApp.BackButton.onClick(handler);
    WebApp.BackButton.show();
    return () => {
      WebApp.BackButton.offClick(handler);
      WebApp.BackButton.hide();
    };
  } catch {
    return () => {};
  }
}

export function buzz(kind: 'success' | 'error'): void {
  try {
    if (inTelegram()) WebApp.HapticFeedback.notificationOccurred(kind);
  } catch {
    // Older Telegram apps have no haptics.
  }
}
