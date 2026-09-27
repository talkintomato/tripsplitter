# PRD 5: Currency and launch

Depends on PRDs 1 to 4. Runs alone. Owns `src/main.ts`, `Dockerfile` and `docs/deploy.md`, and may edit anything outside `src/core/` and `src/db/`, including `web/`, `src/api/`, `src/bot/`, `src/receipts/`, `src/fx/` and their tests.

Read [README.md](README.md) and `docs/foundation-api.md` first. Rate rules and conversion arithmetic come from PRD 0 and are not reimplemented here.

## Goal

Expenses in any supported currency, and the whole thing running on a server.

## Currency

### How rates behave

- Each trip holds one fixed rate per foreign currency. Every expense in that currency uses it, whatever its date, unless the expense has its own rate.
- Changing a trip rate applies to every expense in that currency, past and future, confirmed or draft, except expenses with their own rate.
- Rates are entered and shown as "1 SGD = 112.4 JPY", home currency first, up to 6 decimal places.

### Rate lookup

Built in PRD 3b. This build passes `createRateSuggester(config)` to the API and to the receipt handlers.

### Setting rates when a trip starts

The first time the Mini App is opened on a trip whose `setup_done` is false, a setup step asks for the home currency and which currencies the trip will use, and shows a rate for each, filled in with a suggestion that the member can change. Saving sets each rate with origin `member` and marks setup done. Skipping marks setup done with nothing set. It can be done later from trip settings.

### A currency not set up in advance

When an expense is created or saved in a currency the trip has no rate for:

- The latest mid-market rate is looked up, the trip rate is created with origin `suggested`, the expense uses it and is saved, and the group gets the notice from PRD 1.
- If the lookup fails, which should be rare, the expense is kept as a draft. The form asks for the rate, and the draft can be confirmed once it is entered.

This is the same path the receipt handlers already use.

### Screens

| Screen | Contents |
|---|---|
| Trip setup | As above |
| Currencies, in trip settings | Home currency, with a change button while it is not locked. Each foreign currency with its rate and whether a member set it or it was suggested. Change rate. Add currency. |
| Change rate | The new rate, then a preview: how many saved expenses will change, and each member's balance before and after. Confirm applies it. |
| Expense form | A currency picker, defaulting to the home currency. The rate in use and where it came from. "Use a different rate for this expense" to set one, and a way to clear it. |
| Expense detail | The original amount and the converted amount, the rate, and its source |

Changing the home currency warns that all rates and per-expense rates on the trip will be cleared, and asks for confirmation.

### API

| Method and path | Purpose |
|---|---|
| `GET /api/trips/:tripId/rates` | Trip rates |
| `GET /api/trips/:tripId/rates/suggest?currency=` | A suggestion, or null |
| `POST /api/trips/:tripId/rates/:currency/preview` | Calls `previewTripRate`. Returns the count, balances before and after, and the snapshot. |
| `PUT /api/trips/:tripId/rates/:currency` | Calls `setTripRate` with the rate and the snapshot from the preview. 409 when the snapshot is out of date. Calls `notifier.tripRateChanged`. |

On the expense routes:

- Requests carry `rateOverride`: a decimal string sets the expense's own rate, `null` clears it, and leaving it out keeps what the expense had.
- Responses carry `fx_rate` and `fx_rate_source`. These are never read from a request. A form that loads an expense and saves it without touching the rate must leave `rateOverride` out.

## Wiring

`src/main.ts` starts one process that:

- loads config and opens the database, applying migrations,
- calls `createBot`, then `registerReceiptHandlers` with `isAllowedChat`, `notifier` and the rate suggester,
- calls `createApi` with `notifier` and the rate suggester,
- serves the built Mini App from `web/dist`,
- starts the bot with long polling when `WEBHOOK_URL` is unset. When it is set, registers the webhook at `/telegram/<WEBHOOK_SECRET>`, and checks Telegram's secret token header on every call.

## Deployment

- `Dockerfile` building the server and the Mini App into one image, with the database on a mounted volume.
- `docs/deploy.md`: BotFather setup (create the bot, register the Mini App and its URL, turn privacy mode off, and note that the bot must be removed from and added back to any group it was in before that change), environment variables, first run, how to restrict the bot to chosen groups if wanted, and how to back up the database file.
- The hosting provider is the owner's choice and is asked for at the start of this build.
- A `/health` route returning the database status.

## End to end check

In a real test group with at least two accounts:

1. Add the bot and post from both accounts. Open the link from a third account that is not in the chat and see it join. Reset the link and see the old one refused.
2. Run trip setup with SGD as home and JPY as a trip currency.
3. Tag a JPY receipt, split it by item, and check each person's SGD amount by hand.
4. Add a manual expense in SGD.
5. Add an expense in a currency that was not set up, and see the suggested trip rate announced.
6. Change the JPY trip rate, check the preview, apply it, and check balances by hand.
7. Give one expense its own rate, change the trip rate again, and see that expense unchanged.
8. Record a settlement. Edit an expense and see the notice. Delete and restore one.
9. Open an expense on two phones, save on one, and see the other refused.
10. End the trip. Add a new expense, which starts a new trip. Settle a debt on the ended trip and see it recorded there.

## Tests

- Rate routes: preview, apply, stale snapshot, a trip from another group.
- An expense saved without `rateOverride` keeps source `trip`.
- An expense in a new currency with and without a suggestion.
- Receipt confirmation with an existing trip rate, a suggestion, and no suggestion.
- The webhook refuses a call without the secret header.

## Done when

The end to end check passes against the deployed server.
