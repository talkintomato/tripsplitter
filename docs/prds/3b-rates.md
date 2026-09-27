# PRD 3b: Rate lookup

Depends on PRD 0. Runs in parallel with PRDs 1, 2 and 3. Owns `src/fx/`, `test/fx/` and `docs/rates.md`.

Read [README.md](README.md) and `docs/foundation-api.md` first.

## Goal

When a trip has no rate for a currency, the latest mid-market rate is looked up and becomes the trip's rate automatically, so a foreign expense is saved without anyone entering a rate.

## What it exports

`createRateSuggester(config)` returning a `RateSuggester` from `src/core/contracts.ts`: `(from, to) => Promise<string | null>`, where the result is the number of units of `to` equal to 1 unit of `from`, as a decimal string with at most 6 decimal places.

Callers in PRDs 2 and 3 already accept a `RateSuggester`. They call it with the home currency as `from` and the expense currency as `to`, then call `setTripRate` with origin `suggested`. This build changes nothing in those callers.

## Source

Frankfurter, which needs no key and no account:

```
GET https://api.frankfurter.dev/v1/latest?base=<from>&symbols=<to>
{"amount":1.0,"base":"SGD","date":"2026-09-25","rates":{"JPY":123.39}}
```

It publishes central bank reference rates once per working day, so the rate can be a few days old over a weekend or holiday. Checked on 2026-09-27: it returned rates from SGD for all ten other supported currencies.

This build confirms the service's current usage limits and terms from its documentation and records them in `docs/rates.md`.

## Behaviour

- Only currencies in `src/core/currencies.ts` are looked up. Anything else returns null without a network call.
- `from` equal to `to` returns `"1"`.
- Results are kept in memory for 6 hours per currency pair. When a lookup fails and an earlier result for the pair is still held, however old, that earlier result is returned.
- Each request times out after 5 seconds, and is tried twice before it counts as failed.
- The rate is read from the response text as a decimal string, never through floating point arithmetic that could change its digits, and trimmed to 6 decimal places.
- A rate that is zero, negative or not a number returns null.
- Failures are logged and never throw.

## When no rate can be found

Expected to be rare. When it happens the expense is kept as a draft, and the form and the draft message ask for the rate, as PRDs 2 and 3 already describe. Nothing is ever saved at a rate of 1 or a guessed rate.

## Tests

With a fake `fetch`:

- A rate returned, for a currency with decimals and for one without.
- The first try failing and the second succeeding.
- Both tries failing, with and without an earlier result held.
- Reuse within 6 hours, and a new lookup after it.
- An unsupported currency makes no network call.
- A timeout.
- A response with a zero, negative or malformed rate, and one missing the requested currency.
- A rate with many decimals trimmed to 6, and a whole number such as `14027` kept as it is.

One live test under `test/fx/live/`, not part of `pnpm test`, that fetches SGD to each supported currency.

## Done when

Tests and typecheck pass, and `docs/rates.md` describes the source and its limits.
