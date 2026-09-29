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
  goFullscreen();
}

/**
 * Full screen on phones, where there is room to gain; left alone on desktop, where a full-screen window is in the way.
 * Needs Telegram 8.0. Swiping down to close is turned off (7.7) so that scrolling a list or a sheet never closes the app;
 * Telegram's own Close button still does.
 */
function goFullscreen(): void {
  try {
    if (!inTelegram()) return;
    const app = WebApp as unknown as {
      platform?: string;
      isVersionAtLeast?(version: string): boolean;
      isFullscreen?: boolean;
      requestFullscreen?(): void;
      disableVerticalSwipes?(): void;
    };
    if (app.platform !== 'ios' && app.platform !== 'android') return;
    if (app.isVersionAtLeast?.('7.7')) app.disableVerticalSwipes?.();
    if (app.isVersionAtLeast?.('8.0') && !app.isFullscreen) app.requestFullscreen?.();
  } catch {
    // An older Telegram: stay in the normal, expanded view.
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

interface LocationManager {
  isLocationAvailable?: boolean;
  init?(callback: () => void): void;
  getLocation?(callback: (location: { latitude: number; longitude: number } | null) => void): void;
  openSettings?(): void;
}
function locationManager(): LocationManager | undefined {
  try { return (WebApp as unknown as { LocationManager?: LocationManager }).LocationManager; }
  catch { return undefined; }
}

export function canOpenLocationSettings(): boolean {
  try { return inTelegram() && typeof locationManager()?.openSettings === 'function'; }
  catch { return false; }
}
export function openLocationSettings(): void {
  try { if (inTelegram()) locationManager()?.openSettings?.(); }
  catch { /* Older clients may expose unsupported methods. */ }
}

/** Requested only from an explicit button tap. Missing Telegram support never falls back to browser GPS. */
export function currentLocation(): Promise<{ lat: number; lng: number } | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(null), 15000);
    let done = false;
    function finish(value: { lat: number; lng: number } | null) {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve(value && Number.isFinite(value.lat) && Math.abs(value.lat) <= 90 && Number.isFinite(value.lng) && Math.abs(value.lng) <= 180 ? value : null);
    }
    try {
      if (inTelegram()) {
        const manager = locationManager();
        if (!manager?.init || !manager.getLocation) { finish(null); return; }
        manager.init(() => {
          try {
            if (manager.isLocationAvailable === false || !manager.getLocation) { finish(null); return; }
            manager.getLocation(value => finish(value ? { lat: value.latitude, lng: value.longitude } : null));
          } catch { finish(null); }
        });
      } else if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(value => finish({ lat: value.coords.latitude, lng: value.coords.longitude }), () => finish(null), { timeout: 10000, maximumAge: 0 });
      } else finish(null);
    } catch { finish(null); }
  });
}

/** Returns true if Telegram opened it; otherwise the anchor follows its normal href. */
export function openExternalLink(url: string): boolean {
  try {
    if (inTelegram() && typeof WebApp.openLink === 'function') { WebApp.openLink(url); return true; }
  } catch { /* Let the browser follow the link. */ }
  return false;
}
