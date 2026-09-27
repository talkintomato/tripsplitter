# PRD 3: Receipt reading

Depends on PRD 0. Owns `src/receipts/` and `test/receipts/`.

Read [README.md](README.md) and `docs/foundation-api.md` first. Use the operations and types from PRD 0 as they are. Anything missing is reported, not patched.

## Goal

A tagged photo becomes a draft expense, or a clear message that it could not be read.

## Boundary with the other builds

This build does not edit `src/bot/` or `src/api/`. It exports:

```
registerReceiptHandlers(bot, config, db, deps)
deps = {
  isAllowedChat: (chatId) => boolean,
  notifier: Notifier,
  suggestRate: RateSuggester,
  readReceipt?: ReceiptReader      // defaults to the Anthropic reader; tests pass a fake
}
```

PRD 5 wires it into the bot. The bot's own middleware has already set up the group and learned the sender before these handlers run.

When `ANTHROPIC_API_KEY` is not set, a tagged photo gets the reply "Receipt reading isn't set up. Tap Add expense to enter it by hand."

## Trigger

A photo is handled only when:

- its caption mentions `@<BOT_USERNAME>`, or
- a message mentioning `@<BOT_USERNAME>` replies to a message containing a photo.

Any other photo is ignored: not downloaded, not sent anywhere, not stored. Chats where `isAllowedChat` is false are ignored.

Caption or reply text other than the mention is used as the description.

## Who may use it

Any human in an allowed chat can tag a photo and tap the buttons. The bot's middleware has already made the sender a member. Bots are ignored.

A button acts only on an expense that belongs to the group of the chat the button was tapped in. This follows from using PRD 0's operations with a scope built from the chat. The button's data holds the expense ID and the version shown in the message, nothing else.

## Steps

1. Call `reserveReceiptRead`. If refused, reply "Daily receipt limit reached. Tap Add expense to enter it by hand." and stop.
2. Reply "Reading receipt..." so the member knows it was seen.
3. Download the largest photo size and call the model.
4. On a network or rate limit error, call `reserveReceiptRead` again before the one retry. If that is refused, treat it as the error outcome.
5. Get the active trip with `getOrCreateActiveTrip`, after the model returns, so that a trip ended in the meantime is handled.
6. Validate the result, then edit the reply into the draft message or the failure message.

Every model call, including a retry, uses one reservation. Reservations are kept whatever the outcome.

## Model call

- Anthropic SDK, model from `RECEIPT_MODEL`.
- Structured output with this shape, validated with zod:

```
is_receipt: boolean
merchant: string | null
date: string | null              ISO date
currency: string | null          ISO 4217 code, as printed or as worked out
currency_certain: boolean        false when guessed from a shared symbol or not shown
items: [{ label: string, quantity: number, amount: string }]
tax: string | null
tax_included: boolean | null     true when prices already include the tax
tip: string | null
service_charge: string | null
discount: string | null
total: string | null
```

- Amounts are decimal strings in major units as printed, such as `"84.50"`. They are converted with `toMinorUnits` for the currency.
- `amount` on an item is the full line total as printed. For "Beer x2 16.00" it is `"16.00"`. Quantity is never multiplied in.
- The prompt tells the model: return what is printed and do not calculate missing values; return `is_receipt: false` for anything that is not a receipt or bill; the list of supported currencies; work out shared symbols such as `$` and `¥` from the merchant's address and language, and set `currency_certain` to false when that is a guess.
- **Negative lines**: a line printed with a negative amount, such as a discount or voucher, is not an item. Its amount, made positive, is added to `discount`, and the line is left out of the items. The prompt asks the model to do this, and the code does it again for any negative item the model still returns.
- The Telegram file URL contains the bot token, so the image is sent to the model as image data, never as a URL.

## Outcomes

| Case | Result |
|---|---|
| Total found, and the items pass `validateExpense` as an items split | Draft with items |
| Total found, items do not pass | Draft with the total and no items. The message adds "I couldn't match the items to the total, so check them." |
| No total found, or `is_receipt` false | "I couldn't read a receipt in that photo. Tap Add expense to enter it by hand." No expense and no file ID stored. |
| Model or network error after the retry | "Receipt reading isn't available right now. Tap Add expense to enter it by hand." No expense and no file ID stored. |

## Draft

Created with `createExpense`, status draft, split type `even` with every active member included.

- Payer and created-by: the member who tagged the photo.
- Date from the receipt, or the Singapore date when the photo was tagged.
- `tax_included` from the model, false when null.

### Currency

| Receipt currency | Draft |
|---|---|
| Supported and certain | That currency |
| Supported and not certain | That currency, with `currency_needs_review` true |
| Not shown | Home currency, with `currency_needs_review` true |
| Not in the supported list | Home currency, with `currency_needs_review` true. The printed numbers are kept, rounded half up to the number of decimals the home currency has, so `84.50` in a trip with JPY as home becomes `85`. The message names the currency that was printed. |

A draft with `currency_needs_review` cannot be confirmed until a member opens it and saves it with the currency chosen, which clears the flag.

### Rate

The draft never gets a made-up rate. PRD 0 works out the rate: `home` when the currencies match, the trip's rate when it has one, otherwise `missing`.

When the result is `missing`, call `deps.suggestRate(homeCurrency, currency)`. If it returns a rate, call `setTripRate` with origin `suggested`, which also resolves the draft, and call `notifier.tripRateChanged`. Only if it returns null does the draft stay `missing`.

## Draft message

```
Casa Pepe · 84.50 SGD · 12 items
Paid by Ana
[ Split evenly ]  [ Open to split ]
```

Extra lines when they apply:

- "Check the currency before saving. The receipt shows EUR, which isn't supported." or "Check the currency before saving."
- "Couldn't look up an exchange rate. Open to set it."
- The duplicate warning below.

**Open to split** is a URL button from `launchUrl` with view `expense` and the draft's ID.

**Split evenly** calls `confirmExpense` with the version held in the button:

| Result | Reply |
|---|---|
| Confirmed | The message is replaced with the saved line and an Edit button, and `notifier.expenseSaved` is called. The payer can be changed through Edit. |
| Version out of date | "This draft was changed. Open it to see the latest." |
| Already confirmed, discarded or deleted | "Already handled." |
| Currency needs review | "Check the currency first. Tap Open to split." |
| Rate missing | The lookup is tried once more. If it now succeeds the expense is confirmed. Otherwise: "Couldn't look up an exchange rate. Tap Open to split to enter one." |
| Trip ended | "That trip has ended. Reopen it or add this to the new trip." |

Nothing is changed in any case but the first.

## Duplicate warning

`findPossibleDuplicates` looks for a confirmed expense or open draft in the same trip with the same total, currency and date, and the same merchant ignoring case and spacing. When one is found the draft message adds "This looks like one already added: Casa Pepe, 84.50 SGD, by Sam." The draft is still created.

## Live test set

`test/receipts/live/` holds the owner's real receipt photos with an expected result file for each. `pnpm test:receipts` runs them against the live model and reports, per receipt, whether merchant, total, currency and item count match. It needs a key and costs money, so it is not part of `pnpm test`. Until the owner supplies photos the folder holds only its README.

## Tests

With a fake reader, under `test/receipts/` outside `live/`:

- Each outcome in the table.
- Both trigger forms, and an untagged photo ignored without a download.
- The cap: refused at the limit, a retry uses a second reservation, and a retry refused at the limit.
- A tap by a bot is ignored.
- A button for an expense of another group changes nothing.
- An item with quantity 2 keeps its line total.
- A negative line is moved into the discount.
- An unsupported currency with decimals in a trip whose home currency has none.
- Minor unit conversion for JPY and for SGD.
- Each row of the currency table.
- A foreign receipt with no trip rate gives a draft with source `missing` that Split evenly refuses.
- A foreign receipt with a trip rate gives a draft that Split evenly confirms.
- A suggested rate creates the trip rate and posts the notice.
- Each row of the Split evenly table, including a draft edited after the message was posted.
- The duplicate warning.
- No key configured.

## Done when

Tests and typecheck pass. With a key and a token, a tagged receipt in the test group produces a draft.
