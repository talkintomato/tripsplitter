import type { Config } from '../config.js';
import type { RateSuggester } from '../core/contracts.js';
import { isSupportedCurrency } from '../core/currencies.js';
import { extractRateLiteral, normaliseRateLiteral } from './decimal.js';

export { RATE_DECIMALS, extractRateLiteral, normaliseRateLiteral } from './decimal.js';

/** Where rates come from. See docs/rates.md. */
export const FRANKFURTER_LATEST_URL = 'https://api.frankfurter.dev/v1/latest';

/** How long a result is reused for its currency pair. */
export const RATE_CACHE_MS = 6 * 60 * 60 * 1000;

/** How long one request may take, from sending it to having read the whole body. */
export const RATE_TIMEOUT_MS = 5_000;

/** How many times a request is tried before the lookup counts as failed. */
export const RATE_ATTEMPTS = 2;

/** The part of `fetch` this module uses. The global `fetch` fits. */
export type RateFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface RateSuggesterOptions {
  /** Replaces the global `fetch`, for tests. */
  fetch?: RateFetch;
  /** The clock in milliseconds, `Date.now` by default. */
  now?: () => number;
  /** Receives one line per failure, `console.warn` by default. */
  log?: (message: string) => void;
  /** Pause between the first and the second try, 250 ms by default. */
  retryDelayMs?: number;
}

interface Held {
  rate: string;
  fetchedAt: number;
}

/**
 * Builds the rate lookup of PRD 3b. The returned function gives the number of units of `to`
 * equal to 1 unit of `from`, as a decimal string with at most 6 decimal places, or null when
 * no rate can be found. It never throws.
 *
 * `config` is accepted so every service is built the same way; no setting is read from it today.
 * Results are held in memory per suggester, so build one and share it.
 */
export function createRateSuggester(_config: Config, options: RateSuggesterOptions = {}): RateSuggester {
  const doFetch: RateFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(message));
  const retryDelayMs = options.retryDelayMs ?? 250;

  const held = new Map<string, Held>();
  const inFlight = new Map<string, Promise<string | null>>();

  const safeLog = (message: string): void => {
    try {
      log(`[fx] ${message}`);
    } catch {
      // A broken logger must not break a lookup.
    }
  };

  async function requestOnce(from: string, to: string): Promise<string> {
    const url = `${FRANKFURTER_LATEST_URL}?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${RATE_TIMEOUT_MS} ms`));
      }, RATE_TIMEOUT_MS);
    });
    const work = (async () => {
      const response = await doFetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    })();
    // When the timeout wins, `work` may still reject later. That is already handled here.
    work.catch(() => undefined);
    try {
      const body = await Promise.race([work, timeout]);
      return readRate(body, from, to);
    } finally {
      clearTimeout(timer);
    }
  }

  async function lookUp(from: string, to: string, key: string): Promise<string | null> {
    for (let attempt = 1; attempt <= RATE_ATTEMPTS; attempt += 1) {
      try {
        const rate = await requestOnce(from, to);
        held.set(key, { rate, fetchedAt: now() });
        return rate;
      } catch (error) {
        safeLog(`${from} to ${to}, try ${attempt} of ${RATE_ATTEMPTS} failed: ${describe(error)}`);
        if (attempt < RATE_ATTEMPTS && retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    }
    const earlier = held.get(key);
    if (earlier) {
      safeLog(`${from} to ${to}: using the earlier rate ${earlier.rate}`);
      return earlier.rate;
    }
    safeLog(`${from} to ${to}: no rate found`);
    return null;
  }

  return async (from, to) => {
    try {
      if (!isSupportedCurrency(from) || !isSupportedCurrency(to)) return null;
      if (from === to) return '1';

      const key = `${from}:${to}`;
      const current = held.get(key);
      if (current) {
        const age = now() - current.fetchedAt;
        if (age >= 0 && age < RATE_CACHE_MS) return current.rate;
      }

      const running = inFlight.get(key);
      if (running) return await running;

      const lookup = lookUp(from, to, key).finally(() => inFlight.delete(key));
      inFlight.set(key, lookup);
      return await lookup;
    } catch (error) {
      safeLog(`${String(from)} to ${String(to)}: unexpected error: ${describe(error)}`);
      return null;
    }
  };
}

/** Reads the rate for `to` out of a response body. Throws with the reason when there is none. */
function readRate(body: string, from: string, to: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('the response is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('the response is not an object');
  const { base, rates } = parsed as { base?: unknown; rates?: unknown };
  if (base !== from) throw new Error(`the response is for base ${JSON.stringify(base)}, not ${from}`);
  if (typeof rates !== 'object' || rates === null) throw new Error('the response has no rates');
  if (!Object.hasOwn(rates, to)) throw new Error(`the response has no rate for ${to}`);
  if (typeof (rates as Record<string, unknown>)[to] !== 'number') {
    throw new Error(`the rate for ${to} is not a number`);
  }

  // The parsed value only checks the shape. The digits come from the text itself.
  const literal = extractRateLiteral(body, to);
  if (literal === null) throw new Error(`the rate for ${to} could not be read from the response text`);
  const rate = normaliseRateLiteral(literal);
  if (rate === null) throw new Error(`the rate for ${to} is not above zero: ${literal}`);
  return rate;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
