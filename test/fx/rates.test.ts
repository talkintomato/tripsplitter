import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConfig } from '../../src/config.js';
import { CURRENCIES } from '../../src/core/currencies.js';
import {
  RATE_CACHE_MS,
  RATE_TIMEOUT_MS,
  createRateSuggester,
  extractRateLiteral,
  normaliseRateLiteral,
  type RateFetch,
} from '../../src/fx/index.js';

type Step = { body: string; status?: number } | { error: Error } | { hang: true };

/** A fetch that answers with the given steps in order, and records every call. */
function fakeFetch(steps: Step[]) {
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const queue = [...steps];
  const fetch: RateFetch = (url, init) => {
    calls.push(url);
    signals.push(init.signal);
    const step = queue.shift();
    if (!step) return Promise.reject(new Error('the fake fetch has no step left'));
    if ('error' in step) return Promise.reject(step.error);
    if ('hang' in step) return new Promise(() => undefined);
    const status = step.status ?? 200;
    return Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(step.body) });
  };
  return { fetch, calls, signals };
}

function body(base: string, rates: string): string {
  return `{"amount":1.0,"base":"${base}","date":"2026-09-25","rates":{${rates}}}`;
}

function build(steps: Step[], extra: { now?: () => number } = {}) {
  const fake = fakeFetch(steps);
  const logs: string[] = [];
  const suggest = createRateSuggester(buildConfig(), {
    fetch: fake.fetch,
    log: (message) => logs.push(message),
    retryDelayMs: 0,
    ...extra,
  });
  return { suggest, logs, ...fake };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a rate returned', () => {
  it('for a currency with decimals', async () => {
    const { suggest, calls } = build([{ body: body('SGD', '"USD":0.78301') }]);
    expect(await suggest('SGD', 'USD')).toBe('0.78301');
    expect(calls).toEqual(['https://api.frankfurter.dev/v1/latest?base=SGD&symbols=USD']);
  });

  it('for a currency without decimals', async () => {
    const { suggest, calls } = build([{ body: body('SGD', '"JPY":123.39') }]);
    expect(await suggest('SGD', 'JPY')).toBe('123.39');
    expect(calls).toEqual(['https://api.frankfurter.dev/v1/latest?base=SGD&symbols=JPY']);
  });

  it('is read from the requested currency when the response holds several', async () => {
    const { suggest } = build([{ body: body('SGD', '"IDR":14027,"JPY":123.39,"KRW":1061.02') }]);
    expect(await suggest('SGD', 'JPY')).toBe('123.39');
  });

  it('is read from a response with spaces and line breaks', async () => {
    const text = '{\n  "amount": 1.0,\n  "base": "SGD",\n  "rates": {\n    "THB" : 26.109\n  }\n}';
    const { suggest } = build([{ body: text }]);
    expect(await suggest('SGD', 'THB')).toBe('26.109');
  });

  it('gives "1" for the same currency, without a network call', async () => {
    const { suggest, calls } = build([]);
    expect(await suggest('SGD', 'SGD')).toBe('1');
    expect(calls).toEqual([]);
  });
});

describe('retries', () => {
  it('the first try failing and the second succeeding', async () => {
    const { suggest, calls, logs } = build([{ error: new Error('socket closed') }, { body: body('SGD', '"MYR":3.19') }]);
    expect(await suggest('SGD', 'MYR')).toBe('3.19');
    expect(calls).toHaveLength(2);
    expect(logs.join('\n')).toContain('socket closed');
  });

  it('an error status on the first try and success on the second', async () => {
    const { suggest, calls } = build([{ body: 'busy', status: 503 }, { body: body('SGD', '"MYR":3.19') }]);
    expect(await suggest('SGD', 'MYR')).toBe('3.19');
    expect(calls).toHaveLength(2);
  });

  it('both tries failing without an earlier result gives null', async () => {
    const { suggest, calls, logs } = build([{ error: new Error('down') }, { body: '', status: 500 }]);
    expect(await suggest('SGD', 'MYR')).toBeNull();
    expect(calls).toHaveLength(2);
    expect(logs.length).toBeGreaterThanOrEqual(2);
  });

  it('both tries failing with an earlier result gives that result, however old', async () => {
    let time = 1_000_000;
    const { suggest, calls } = build(
      [{ body: body('SGD', '"MYR":3.19') }, { error: new Error('down') }, { error: new Error('down') }],
      { now: () => time },
    );
    expect(await suggest('SGD', 'MYR')).toBe('3.19');
    time += 30 * 24 * 60 * 60 * 1000;
    expect(await suggest('SGD', 'MYR')).toBe('3.19');
    expect(calls).toHaveLength(3);
  });

  it('an earlier result for another pair is not used', async () => {
    let time = 0;
    const { suggest } = build(
      [{ body: body('SGD', '"MYR":3.19') }, { error: new Error('down') }, { error: new Error('down') }],
      { now: () => time },
    );
    expect(await suggest('SGD', 'MYR')).toBe('3.19');
    time += RATE_CACHE_MS;
    expect(await suggest('MYR', 'SGD')).toBeNull();
  });

  it('never throws, even when fetch throws at once or the logger throws', async () => {
    const suggest = createRateSuggester(buildConfig(), {
      fetch: () => {
        throw new Error('thrown, not rejected');
      },
      log: () => {
        throw new Error('logger broken');
      },
      retryDelayMs: 0,
    });
    await expect(suggest('SGD', 'MYR')).resolves.toBeNull();
  });
});

describe('reuse', () => {
  it('within 6 hours makes no new lookup, and after it makes one', async () => {
    let time = 5_000;
    const { suggest, calls } = build([{ body: body('SGD', '"JPY":123.39') }, { body: body('SGD', '"JPY":124.01') }], {
      now: () => time,
    });
    expect(await suggest('SGD', 'JPY')).toBe('123.39');

    time += RATE_CACHE_MS - 1;
    expect(await suggest('SGD', 'JPY')).toBe('123.39');
    expect(calls).toHaveLength(1);

    time += 1;
    expect(await suggest('SGD', 'JPY')).toBe('124.01');
    expect(calls).toHaveLength(2);
  });

  it('is 6 hours', () => {
    expect(RATE_CACHE_MS).toBe(21_600_000);
  });

  it('is per currency pair', async () => {
    const { suggest, calls } = build([{ body: body('SGD', '"JPY":123.39') }, { body: body('SGD', '"KRW":1061.02') }]);
    expect(await suggest('SGD', 'JPY')).toBe('123.39');
    expect(await suggest('SGD', 'KRW')).toBe('1061.02');
    expect(calls).toHaveLength(2);
  });

  it('two lookups of one pair at the same moment share one request', async () => {
    const { suggest, calls } = build([{ body: body('SGD', '"JPY":123.39') }]);
    expect(await Promise.all([suggest('SGD', 'JPY'), suggest('SGD', 'JPY')])).toEqual(['123.39', '123.39']);
    expect(calls).toHaveLength(1);
  });

  it('a failed lookup is not held: the next call looks up again', async () => {
    const { suggest, calls } = build([
      { error: new Error('down') },
      { error: new Error('down') },
      { body: body('SGD', '"JPY":123.39') },
    ]);
    expect(await suggest('SGD', 'JPY')).toBeNull();
    expect(await suggest('SGD', 'JPY')).toBe('123.39');
    expect(calls).toHaveLength(3);
  });
});

describe('unsupported currencies', () => {
  it.each([
    ['SGD', 'EUR'],
    ['EUR', 'SGD'],
    ['SGD', 'jpy'],
    ['SGD', ''],
    ['EUR', 'EUR'],
    ['SGD', 'JPY&symbols=USD'],
  ])('%s to %s gives null and makes no network call', async (from, to) => {
    const { suggest, calls } = build([{ body: body('SGD', '"EUR":0.67') }]);
    expect(await suggest(from, to)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('a timeout', () => {
  it('ends each try after 5 seconds, and gives null after two', async () => {
    vi.useFakeTimers();
    expect(RATE_TIMEOUT_MS).toBe(5_000);
    const { suggest, calls, signals, logs } = build([{ hang: true }, { hang: true }]);
    let result: string | null | undefined;
    void suggest('SGD', 'JPY').then((value) => {
      result = value;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(calls).toHaveLength(2);
    expect(result).toBeUndefined();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeNull();
    expect(signals[1]?.aborted).toBe(true);
    expect(logs.join('\n')).toContain('timed out');
  });

  it('on the first try, then an answer on the second', async () => {
    vi.useFakeTimers();
    const { suggest } = build([{ hang: true }, { body: body('SGD', '"JPY":123.39') }]);
    const pending = suggest('SGD', 'JPY');
    await vi.advanceTimersByTimeAsync(RATE_TIMEOUT_MS);
    expect(await pending).toBe('123.39');
  });

  it('covers a body that never arrives', async () => {
    vi.useFakeTimers();
    const slow: RateFetch = () =>
      Promise.resolve({ ok: true, status: 200, text: () => new Promise<string>(() => undefined) });
    const suggest = createRateSuggester(buildConfig(), { fetch: slow, log: () => undefined, retryDelayMs: 0 });
    const pending = suggest('SGD', 'JPY');
    await vi.advanceTimersByTimeAsync(2 * RATE_TIMEOUT_MS);
    expect(await pending).toBeNull();
  });
});

describe('a response that holds no usable rate gives null', () => {
  it.each([
    ['zero', body('SGD', '"JPY":0')],
    ['zero with decimals', body('SGD', '"JPY":0.000')],
    ['too small to show in 6 decimals', body('SGD', '"JPY":0.0000004')],
    ['negative', body('SGD', '"JPY":-123.39')],
    ['text in place of a number', body('SGD', '"JPY":"123.39"')],
    ['null in place of a number', body('SGD', '"JPY":null')],
    ['NaN, which is not JSON', body('SGD', '"JPY":NaN')],
    ['a number with a comma', body('SGD', '"JPY":"1,234.5"')],
    ['the requested currency missing', body('SGD', '"KRW":1061.02')],
    ['empty rates', body('SGD', '')],
    ['no rates at all', '{"amount":1.0,"base":"SGD","date":"2026-09-25"}'],
    ['rates that is not an object', '{"base":"SGD","rates":123.39}'],
    ['another base than asked for', body('USD', '"JPY":123.39')],
    ['the not found message', '{"message":"not found"}'],
    ['a cut off body', '{"amount":1.0,"base":"SGD","rates":{"JPY":123.'],
    ['a web page', '<html><body>Service unavailable</body></html>'],
    ['an empty body', ''],
    ['a JSON array', '[123.39]'],
  ])('%s', async (_name, text) => {
    const { suggest, logs } = build([{ body: text }, { body: text }]);
    expect(await suggest('SGD', 'JPY')).toBeNull();
    expect(logs.length).toBeGreaterThan(0);
  });

  it('and an earlier result is kept in its place', async () => {
    let time = 0;
    const zero = body('SGD', '"JPY":0');
    const { suggest } = build([{ body: body('SGD', '"JPY":123.39') }, { body: zero }, { body: zero }], {
      now: () => time,
    });
    expect(await suggest('SGD', 'JPY')).toBe('123.39');
    time += RATE_CACHE_MS;
    expect(await suggest('SGD', 'JPY')).toBe('123.39');
  });
});

describe('digits', () => {
  it('a rate with many decimals is trimmed to 6', async () => {
    const { suggest } = build([{ body: body('SGD', '"GBP":0.590851234567') }]);
    expect(await suggest('SGD', 'GBP')).toBe('0.590851');
  });

  it('trimming cuts and does not round up', async () => {
    const { suggest } = build([{ body: body('SGD', '"GBP":0.5908519999') }]);
    expect(await suggest('SGD', 'GBP')).toBe('0.590851');
  });

  it('a whole number is kept as it is', async () => {
    const { suggest } = build([{ body: body('SGD', '"IDR":14027') }]);
    expect(await suggest('SGD', 'IDR')).toBe('14027');
  });

  it('digits a floating point number cannot hold are kept', async () => {
    // As a JS number this is 12345678901234567000, and 0.1234565 style values round differently.
    const { suggest } = build([{ body: body('SGD', '"IDR":12345678901234567891.123456789') }]);
    expect(await suggest('SGD', 'IDR')).toBe('12345678901234567891.123456');
  });

  it.each([
    ['123.39', '123.39'],
    ['14027', '14027'],
    ['14027.0', '14027'],
    ['1.0', '1'],
    ['3.190000', '3.19'],
    ['0.78301', '0.78301'],
    ['0.0000019', '0.000001'],
    ['1.1138', '1.1138'],
    ['007.5', '7.5'],
    ['1.2339e2', '123.39'],
    ['1.2339E+2', '123.39'],
    ['7.8301e-1', '0.78301'],
    ['5e-7', null],
    ['5e-6', '0.000005'],
    ['14027e0', '14027'],
    ['1e3', '1000'],
    ['1e400', null],
    ['0', null],
    ['0.0', null],
    ['-1', null],
    ['NaN', null],
    ['Infinity', null],
    ['1,5', null],
    ['', null],
    ['.5', null],
    ['1.', null],
  ])('normaliseRateLiteral(%j) is %j', (literal, expected) => {
    expect(normaliseRateLiteral(literal)).toBe(expected);
  });

  it('extractRateLiteral reads only from the rates object and only the exact code', () => {
    expect(extractRateLiteral('{"JPY":5,"base":"SGD","rates":{"KRW":1061.02}}', 'JPY')).toBeNull();
    expect(extractRateLiteral('{"rates":{"XJPY":1,"JPY":123.39}}', 'JPY')).toBe('123.39');
    expect(extractRateLiteral('{"rates":{"JPY":123.39},"other":{"KRW":2}}', 'KRW')).toBeNull();
  });

  it('every result fits the rate format of the foundation', async () => {
    for (const currency of CURRENCIES) {
      if (currency.code === 'SGD') continue;
      const { suggest } = build([{ body: body('SGD', `"${currency.code}":26.1090004`) }]);
      expect(await suggest('SGD', currency.code)).toMatch(/^\d+(\.\d{1,6})?$/);
    }
  });
});
