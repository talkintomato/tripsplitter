// The only file that talks to Telegram. Everything here also works in a normal browser,
// where there is no sign-in data and the start parameter comes from the address.
import sdk from '@twa-dev/sdk';

type TelegramWebApp = typeof sdk;

/**
 * Telegram's object, read from the page. Importing the library above runs Telegram's script, which
 * puts the object on `window`. The library's own default export is not used directly: depending on
 * how the bundler wraps it, it can arrive without its fields, which left the sign-in data empty.
 */
function telegram(): TelegramWebApp {
  const fromPage = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
  if (fromPage) return fromPage;
  const wrapped = sdk as unknown as { default?: TelegramWebApp };
  return wrapped.default ?? sdk;
}

const WebApp = new Proxy({} as TelegramWebApp, {
  get: (_target, property) => Reflect.get(telegram() as object, property),
});

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
  applyTheme();
  try {
    WebApp.onEvent('themeChanged', applyTheme);
  } catch {
    // Not in Telegram.
  }
  try {
    WebApp.ready();
    WebApp.expand();
  } catch {
    // Not in Telegram.
  }
}

/**
 * Light or dark. Inside Telegram it is Telegram's choice. In a browser it is `?theme=` when given, for trying both,
 * and otherwise nothing: the stylesheet then follows the system's setting.
 */
export function colorScheme(): 'light' | 'dark' | null {
  if (inTelegram()) {
    try {
      const scheme = WebApp.colorScheme;
      if (scheme === 'light' || scheme === 'dark') return scheme;
    } catch {
      // Older Telegram apps: fall through to the system's setting.
    }
    return null;
  }
  const asked = new URLSearchParams(window.location.search).get('theme');
  return asked === 'light' || asked === 'dark' ? asked : null;
}

/**
 * Uses the app's own palette in the chosen scheme, and paints Telegram's header and background with the same
 * colour so the frame matches the page.
 */
export function applyTheme(): void {
  const root = document.documentElement;
  const scheme = colorScheme();
  if (scheme) root.dataset.theme = scheme;
  else delete root.dataset.theme;
  if (!inTelegram()) return;
  const background = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (!/^#[0-9a-f]{6}$/i.test(background)) return;
  const paint = (name: 'setHeaderColor' | 'setBackgroundColor' | 'setBottomBarColor'): void => {
    try {
      const set = (WebApp as unknown as Record<string, ((color: string) => void) | undefined>)[name];
      set?.call(telegram(), background);
    } catch {
      // Older Telegram apps cannot change these colours.
    }
  };
  paint('setHeaderColor');
  paint('setBackgroundColor');
  paint('setBottomBarColor');
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
