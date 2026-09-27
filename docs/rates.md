# Rate lookup

Built by PRD 3b. Code in `src/fx/`, tests in `test/fx/`.

## What it does

`createRateSuggester(config, options?)` from `src/fx/index.js` returns a `RateSuggester`: `(from, to) => Promise<string | null>`. The result is the number of units of `to` equal to 1 unit of `from`, as a decimal string with at most 6 decimal places, or null when no rate can be found. It never throws.

```ts
import { createRateSuggester } from './fx/index.js';

const suggestRate = createRateSuggester(config);
const rate = await suggestRate('SGD', 'JPY'); // "123.39"
```

Build one suggester and share it, because the held results live inside it.

Options, all optional: `fetch` (replaces the global `fetch`, for tests), `now` (the clock in milliseconds), `log` (receives one line per failure, `console.warn` by default), `retryDelayMs` (pause between the two tries, 250 by default).

## Behaviour

| Case | Result |
|---|---|
| `from` or `to` not in `src/core/currencies.ts` (case-sensitive) | null, no network call |
| `from` equal to `to` | `"1"`, no network call |
| A result for the pair less than 6 hours old | that result, no network call |
| Two calls for one pair at the same moment | one request, shared |
| A request takes more than 5 seconds, including reading the body | that try fails |
| A try fails for any reason | tried once more after 250 ms |
| Both tries fail, an earlier result for the pair is held | the earlier result, however old |
| Both tries fail, nothing held | null |

A try fails on: a network error, a timeout, a status outside 200 to 299, a body that is not JSON, a `base` other than the one asked for, the requested currency missing, a rate that is not a JSON number, and a rate that is zero or negative or becomes zero when cut to 6 decimals.

Every failure is logged as one line starting with `[fx]`. The lines hold currency codes and the reason, nothing else.

Results are held in memory only. They are lost when the process restarts.

## Digits

The rate is taken from the text of the response, not from the parsed number. `JSON.parse` is used only to check the shape of the response. The text of the number is then cut to 6 decimal places (cut, not rounded), zeros at the end of the fraction are dropped (`14027.0` becomes `14027`), and exponent notation such as `1.2339e2` is rewritten as `123.39` by moving the decimal point in the text.

## Source

Frankfurter, https://frankfurter.dev, run by Line of Flight. Open source, no key, no account.

```
GET https://api.frankfurter.dev/v1/latest?base=SGD&symbols=JPY
{"amount":1.0,"base":"SGD","date":"2026-09-25","rates":{"JPY":123.39}}
```

An unknown currency gives status 404 with `{"message":"not found"}`.

### Limits and terms, checked on 2026-09-27

Read from https://frankfurter.dev/ (the FAQ) and https://frankfurter.dev/v1/ on 2026-09-27. Both pages loaded.

| Point | What the documentation says |
|---|---|
| Key | None needed. |
| Cost and commercial use | Free, also for commercial use. "The rates themselves fall under each provider's terms." |
| Call limits | "There are no quotas. Requests are rate-limited to prevent abuse, but there are no monthly or daily caps." No number is given for the rate limit. For high volume it advises caching responses or self-hosting. |
| Kind of rate | Mid-market. |
| How fresh | v1: "the latest working day's rates, updated daily around 16:00 CET". Over a weekend or holiday the rate is a few days old. |
| Privacy | The service says it does not collect or log personal data, IP addresses or request URLs. The public instance runs behind Cloudflare. |
| Suitability | Described as fit for billing, e-commerce and accounting, and not built for live trading. |
| v1 | "The v1 API is deprecated in favor of v2, but remains available indefinitely." |

Seen in the response headers on 2026-09-27: `cache-control: public, max-age=86400`, a `deprecation` header, and `link: <https://api.frankfurter.dev/v2/rates>; rel="successor-version"`.

This app's use is far below any sensible limit: at most one request per currency pair per 6 hours per process.

### v1 and v2

This build uses v1, as PRD 3b specifies. The documentation now leads with v2 (`/v2/rates?base=sgd&quotes=jpy`, `/v2/rate/sgd/jpy`), which blends rates from many central banks where v1 gives the European Central Bank's reference rates. v2 has a different response shape and was not tried in this build. Moving to it means changing the address and the reading of the response in `src/fx/index.ts`.

### Rates on 2026-09-27

Returned by the live test, all dated 2026-09-25, for 1 SGD:

| Currency | Rate |
|---|---|
| MYR | 3.19 |
| THB | 26.109 |
| IDR | 14027 |
| JPY | 123.39 |
| KRW | 1061.02 |
| CNY | 5.2565 |
| USD | 0.78301 |
| GBP | 0.59085 |
| AUD | 1.1138 |
| NZD | 1.3808 |

## Tests

- `pnpm vitest run test/fx`: all behaviour above, with a fake `fetch`. Part of `pnpm test`.
- `pnpm test:fx`: `test/fx/live/frankfurter.test.ts`, which calls the real service for SGD to each supported currency and checks that each result starts with the digits the service sent. Needs network access.
