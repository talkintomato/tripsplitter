# PRD 0: Foundation

## Goal

A repository that later builds can work in at the same time without touching shared files: tooling, database, the money maths, the activity log, access checks, and the shared types that the bot, API and receipt reader use to talk to each other. No Telegram connection and no user interface.

Read the shared decisions in [README.md](README.md) first. They bind this build.

## Tooling

- Node 22, TypeScript strict, pnpm, one package, ESM.
- Dependencies to install now, for all PRDs: `grammy`, `hono`, `@hono/node-server`, `better-sqlite3`, `zod`, `openai`, `react`, `react-dom`, `react-router-dom`, `@twa-dev/sdk`. Dev: `typescript`, `vitest`, `vite`, `@vitejs/plugin-react`, `tsx`, `jsdom`, `@testing-library/react`, `@types/node`, `@types/better-sqlite3`, `@types/react`, `@types/react-dom`.
- Scripts: `dev`, `build`, `start`, `test`, `test:receipts`, `typecheck`, `web:dev`, `web:build`.
- `pnpm test` runs everything under `test/` except `test/receipts/live/`. `pnpm test:receipts` runs only `test/receipts/live/` with its own Vitest config. This build creates that folder with a README and no tests.
- `web/` holds a Vite and React scaffold with a placeholder page.
- `.env.example` lists every variable below with placeholder values.

## Configuration (`src/config.ts`)

| Variable | Meaning | Default |
|---|---|---|
| `NODE_ENV` | `development`, `test` or `production` | `development` |
| `BOT_TOKEN` | Telegram bot token | required |
| `BOT_USERNAME` | Bot username without `@` | required |
| `MINI_APP_NAME` | Short name of the Mini App registered with BotFather | required |
| `ALLOWED_CHAT_IDS` | Optional. Empty means the bot works in every chat it is added to. When chat IDs are listed, comma-separated, it works only in those. | empty |
| `LINK_SECRET` | Secret for signing links, at least 32 characters | required |
| `DATABASE_PATH` | SQLite file | `./data/tripsplitter.db` |
| `OPENAI_API_KEY` | Key for receipt reading | optional; receipt reading is off without it |
| `RECEIPT_MODEL` | Model ID for receipt reading | `gpt-6-luna` |
| `RECEIPT_DAILY_CAP` | Model calls per group per day | `30` |
| `PORT` | HTTP port | `3000` |
| `WEBHOOK_URL` | Public base URL. Unset means long polling. | unset |
| `WEBHOOK_SECRET` | Secret path segment and header value for the webhook | required when `WEBHOOK_URL` is set |
| `DEV_FAKE_USER` | JSON of a fake Telegram user, for local screen work | unset; startup fails if set while `NODE_ENV` is `production` |

Validated with zod. A missing required value stops startup with a message naming the variable. `loadConfig(env)` takes the environment as an argument so tests can build a config without real variables.

## Database (`src/db/`)

SQLite through `better-sqlite3`, WAL mode, foreign keys on. Migrations are numbered SQL files applied in order at startup and recorded in a `migration` table. `openDatabase(path)` accepts `:memory:` for tests.

| Table | Fields |
|---|---|
| `chat_group` | id, chat_id (unique), title, intro_message_id, link_version (starts at 1), created_at |
| `chat_alias` | id, group_id, chat_id (unique). Earlier chat IDs of a group that was upgraded. |
| `member` | id, group_id, telegram_user_id (null for hand-added), display_name, username, active, joined_via (`chat`, `link` or `manual`), merged_into (null unless absorbed by a merge), created_at. Unique on (group_id, telegram_user_id) where not null. |
| `trip` | id, group_id, name, home_currency, home_currency_locked, status (`active` or `ended`), setup_done, created_at, ended_at. At most one active trip per group, enforced by a partial unique index. |
| `trip_fx_rate` | id, trip_id, currency, rate, origin (`suggested` or `member`), set_by, updated_at. Unique on (trip_id, currency). |
| `expense` | id, trip_id, created_by, payer_id, description, merchant, expense_date, total, tax, tax_included, tip, service_charge, discount, currency, currency_needs_review, fx_rate, fx_rate_source, split_type (`even`, `portions`, `items`), receipt_file_id, status (`draft`, `confirmed`, `discarded`, `deleted`), status_before_removal, version, created_at, updated_at |
| `expense_item` | id, expense_id, label, quantity, amount, position |
| `share` | id, member_id, weight, and exactly one of expense_id or item_id, enforced by a check constraint. Weight is a positive integer. |
| `settlement` | id, trip_id, created_by, from_member_id, to_member_id, amount (home currency), status (`active` or `undone`), version, created_at |
| `activity` | id, group_id, trip_id, actor_kind (`member` or `system`), actor_id (null for system), action, entity_type, entity_id, before (JSON), after (JSON), created_at |
| `receipt_read` | id, group_id, day (Singapore date), created_at |

Triggers reject any UPDATE or DELETE on `activity`.

### Operations, not table access

`src/db/` exports named operations. It does not export generic create, update or delete functions for tables, and it exports no way to write `activity` directly.

Every operation that reads or changes group data takes a `scope` as its first argument:

```
type Actor = { kind: 'member', memberId: number } | { kind: 'system' }
type Scope = { groupId: number, actor: Actor }
```

Rules for every operation:

- A record is loaded by following its chain to the group: expense to trip to group, item to expense, share to expense or item, settlement to trip. If the chain does not end at `scope.groupId`, the operation throws `NotFoundError`, the same as for a missing record.
- Every member ID passed in (payer, share member, settlement parties) must belong to `scope.groupId` and must not have `merged_into` set. Otherwise `ValidationError`.
- A member assigned to an item must be included in the expense.
- The change and its activity entries commit in one transaction.
- Operations on an existing expense or settlement take `expectedVersion` and throw `StaleEditError`, carrying the current record, when it differs. Each successful change adds 1 to the version.

Required operations, at minimum:

| Area | Operations |
|---|---|
| Group | `ensureGroup(chatId, title, humans[])`: creates the group, its first members and its first trip if the group does not exist, recorded with the system actor, and returns the existing group unchanged if it does. `migrateChat(oldChatId, newChatId)`: updates `chat_id` and records the old one in `chat_alias`; safe to call twice. `findGroupByChatId(chatId)`: matches current ID or alias. `setIntroMessage`. `resetLink(scope)`: adds 1 to `link_version` and logs it. |
| Members | `upsertTelegramMember`, `setMemberActive`, `addManualMember`, `claimMember`, `listMembers` |
| Trips | `getActiveTrip`, `getOrCreateActiveTrip`, `getTrip`, `listTrips`, `renameTrip`, `changeHomeCurrency`, `completeSetup`, `endTrip`, `reopenTrip` |
| Rates | `listTripRates`, `setTripRate`, `previewTripRate` |
| Expenses | `createExpense`, `getExpense`, `listExpenses`, `saveExpense`, `confirmExpense`, `discardExpense`, `deleteExpense`, `restoreExpense`, `findPossibleDuplicates` |
| Settlements | `createSettlement`, `undoSettlement`, `restoreSettlement`, `listSettlements` |
| Activity | `listActivity(scope, { tripId?, before?, limit })` |
| Receipt cap | `reserveReceiptRead(groupId, cap, now)`: in one transaction, counts rows for the Singapore day of `now` and inserts one if the count is below the cap. Returns whether the reservation was made. |

`docs/foundation-api.md` documents the activity entries each operation writes.

### Expense as one unit

`createExpense` and `saveExpense` take the whole expense: fields, items and shares. `saveExpense` replaces items and shares in the same transaction. There is no operation that changes an item or a share by itself. `setTripRate` and `claimMember` add 1 to the version of every expense they alter, so an open editor holding an old version is refused.

### Status changes

| From | Operation | To |
|---|---|---|
| draft | `confirmExpense` | confirmed |
| draft | `discardExpense` | discarded |
| confirmed | `deleteExpense` | deleted |
| discarded | `restoreExpense` | draft |
| deleted | `restoreExpense` | confirmed |
| active settlement | `undoSettlement` | undone |
| undone settlement | `restoreSettlement` | active |

Any other change of status throws `ValidationError`.

`confirmExpense` refuses when: the trip is ended, `fx_rate_source` is `missing`, `currency_needs_review` is true, or `validateExpense` reports a problem. Restoring a deleted expense runs the same checks.

On an ended trip, the only changes allowed are creating, undoing and restoring settlements, and reopening the trip.

`getOrCreateActiveTrip` creates a trip named after the group when none is active, copying the home currency of the most recent trip.

## Currencies (`src/core/currencies.ts`)

The only place currencies are defined. Adding one is a one-line change.

| Code | Name | Decimals |
|---|---|---|
| SGD | Singapore dollar | 2 |
| MYR | Malaysian ringgit | 2 |
| THB | Thai baht | 2 |
| IDR | Indonesian rupiah | 0 |
| JPY | Japanese yen | 0 |
| KRW | South Korean won | 0 |
| CNY | Chinese yuan | 2 |
| USD | US dollar | 2 |
| GBP | Pound sterling | 2 |
| AUD | Australian dollar | 2 |
| NZD | New Zealand dollar | 2 |

IDR is handled with no decimals because receipts never show them, although the official standard gives it two.

Exports: `CURRENCIES`, `isSupportedCurrency(code)`, `toMinorUnits(amountString, code)`, `formatAmount(minor, code)`. `toMinorUnits` takes a decimal string and refuses more decimals than the currency has. Operations refuse any currency not in the list. The default home currency is SGD.

## Rates

- A rate is a decimal string, greater than zero, with at most 6 decimal places, stored exactly as entered. It is the number of units of the expense currency equal to 1 unit of the home currency: `112.4` means 1 SGD = 112.4 JPY.
- `fx_rate_source` on an expense is one of:
  - `home`: expense currency equals home currency. Rate is `1`.
  - `expense`: set on this expense by a member.
  - `trip`: copied from `trip_fx_rate`.
  - `missing`: foreign currency and the trip has no rate for it. `fx_rate` is null.
- `resolveRate({ expenseCurrency, homeCurrency, expenseOverride, tripRate })` returns the rate and source. Order: home, then expense override, then trip rate, then missing.
- `createExpense` and `saveExpense` take `rateOverride`: a decimal string sets it, `null` clears it, and leaving it out keeps what the expense had. The stored rate and source are always worked out by the operation and never taken from the caller. Changing an expense's currency clears its override unless a new one is supplied in the same call.
- `setTripRate(scope, tripId, currency, rate, origin, expectedSnapshot?)` writes the rate and re-resolves every expense in that trip and currency whose source is `trip` or `missing`, whatever its status, including confirmed ones. Expenses with source `expense` are untouched. It writes one activity entry for the rate and one per expense changed. A trip rate cannot be removed, only changed.
- `previewTripRate(scope, tripId, currency, rate)` changes nothing and returns: how many confirmed expenses would change, balances before and after, and a `snapshot` string derived from the IDs and versions of the affected expenses and the current rate. When `setTripRate` is given `expectedSnapshot` and it no longer matches, it throws `StaleEditError`.
- `changeHomeCurrency(scope, tripId, currency)` is refused when `home_currency_locked` is true. Otherwise, in one transaction: it removes every trip rate, clears every expense override, keeps each expense's own currency and amounts, and re-resolves every expense in the trip to `home` or `missing`. Each change is logged.
- `home_currency_locked` is set to true by the first `confirmExpense` or `createSettlement` in a trip and is never set back.

## Money maths (`src/core/`)

Pure functions with no database access. All arithmetic uses `bigint`. No floating point anywhere in money or rate code.

### Validation

`validateExpense(expense, items, shares)` returns a list of problems, each with a field and a message fit to show a member.

For every split type:

- Total is greater than zero.
- At least one member is included.
- Weights are positive integers.

For `even` and `portions`: nothing more. Items are not required and are ignored.

For `items`:

- At least one item. Item amounts may be zero or positive, never negative.
- Tax, tip, service charge and discount are zero or positive.
- Expected total = sum of item amounts + tip + service charge - discount + (tax when `tax_included` is false). It must equal the total. The problem reports the difference as total minus expected total.
- When any of tax, tip, service charge or discount is not zero, the sum of item amounts must be greater than zero, because they are spread in proportion to it.

`tax_included` is a stored field set by the receipt reader or the member. It is never guessed from the numbers.

### Splitting

`computeShares(expense, items, shares) -> Map<memberId, bigint>` in the expense currency. It throws if `validateExpense` reports a problem.

- **Even**: total divided equally between the included members.
- **Portions**: total divided in proportion to weights.
- **Items**:
  1. Each item's amount is divided between its assigned members by weight. An item with nobody assigned is divided equally between all members included in the expense. Leftover minor units within an item go to the assigned member with the lowest ID.
  2. This gives each member an item subtotal. The sum of subtotals equals the sum of item amounts.
  3. The remainder to spread is total minus the sum of item amounts. It covers tax not already included, tip and service charge, less discount, and may be negative.
  4. The remainder is divided between members in proportion to their item subtotals, rounded toward zero.
- **Rounding for every split type**: after dividing, any leftover minor units needed to make the shares sum exactly to the total go to the payer if the payer is included, otherwise to the included member with the lowest ID.

### Converting to home currency

```
homeMinorExact = expenseMinor × 10^homeDecimals / (rate × 10^expenseDecimals)
```

calculated as an exact fraction. Example: 1124 JPY at rate 112.4 to SGD is 1124 × 100 / (112.4 × 1) = 1000 minor units, which is 10.00 SGD.

`convertExpense(expense, shares, homeCurrency)`:

1. Convert the expense total, rounding half up. This is the amount the payer is credited.
2. Convert each member's share, rounding down.
3. Give the leftover, which is the converted total minus the sum of converted shares, to the payer if included, otherwise to the included member with the lowest ID.

### Balances

`computeBalances(expenses, settlements, homeCurrency) -> Map<memberId, bigint>`. Only confirmed expenses and active settlements count. For each expense the payer is credited the converted total and each member is debited their converted share. For each settlement the payer of the settlement is credited and the receiver debited. Balances always sum to zero.

### Settle-up

`suggestPayments(balances) -> Payment[]`. Repeatedly match the member owed the most with the member who owes the most and pay the smaller of the two amounts. Ties are broken by lowest member ID. At most N-1 payments, and the same result every time for the same input.

### Claiming and merging members

`claimMember(scope, manualMemberId)`, where the actor is the Telegram member making the claim.

- The target must be a hand-added member of the same group that has not been merged.
- The actor's member is the survivor. The hand-added member is absorbed.
- **Refused when it would change anyone else's amounts**: if both members have a share on the same expense or the same item, in any trip, the claim throws `ValidationError` listing those expenses, with the message "Remove one of the two from these expenses first". This is a deliberate simplification.
- Otherwise, in one transaction, across all trips of the group: shares, payer, created-by and set-by references, and both ends of every settlement, including undone ones, move from the absorbed member to the survivor. A settlement that would then be from a member to themselves is marked undone. The absorbed member gets `merged_into` set and `active` false, and no longer appears in member lists. The version of each expense and settlement touched goes up by 1. Every change is logged.
- After a merge, every other member's balance is unchanged, and the survivor's balance equals the sum of the two earlier balances.

## Access (`src/api/auth.ts`)

- `verifyInitData(initData, botToken, now)`: checks the Telegram signature and rejects data older than 24 hours. Returns the Telegram user. A user flagged as a bot is rejected.
- `resolveAccess(db, telegramUser, launch)` returns `{ level: 'write' | 'none', member? }`:
  1. The launch parameter has already been verified by `decodeLaunch`. If its `linkVersion` is not the group's current `link_version`, return `none`.
  2. Find the member by Telegram user ID in the group. If found, return `write`.
  3. Otherwise create the member with `joined_via` set to `link` and `active` true, logged with the system actor, and return `write`.
- There is no read-only level and no check against Telegram chat membership.
- In development only, when `DEV_FAKE_USER` is set, `verifyInitData` is bypassed and that user is returned.

## Links into the Mini App (`src/core/launch.ts`)

Telegram start parameters allow only letters, digits, `_` and `-`, up to 512 characters.

```
type Launch = { groupId: number, linkVersion: number, view: 'home' | 'add' | 'balances' | 'expense', expenseId?: number }
encodeLaunch(launch, secret): string
decodeLaunch(param, secret): Launch        throws on a bad signature or format
launchUrl(config, launch): string          https://t.me/<BOT_USERNAME>/<MINI_APP_NAME>?startapp=<param>
```

Format: `v1_<groupId>_<linkVersion>_<view>_<expenseId or 0>_<signature>`, with the signature an HMAC-SHA256 over the preceding text, base64url, first 22 characters. Links do not expire, and stop working when the group's link is reset. Holding a valid link is what grants access.

The Mini App sends the whole start parameter in the `X-Launch` header on every request. The API decodes it to get the group.

## Shared integration types (`src/core/contracts.ts`)

Types only, so that PRDs 1, 2, 3 and 3b agree without importing each other.

```
interface Notifier {
  expenseSaved(n: ExpenseNotice): Promise<void>
  expenseEdited(n: ExpenseNotice & { changes: string[] }): Promise<void>
  expenseDeleted(n: ExpenseNotice): Promise<void>
  expenseRestored(n: ExpenseNotice): Promise<void>
  settlementRecorded(n: SettlementNotice): Promise<void>
  settlementUndone(n: SettlementNotice): Promise<void>
  settlementRestored(n: SettlementNotice): Promise<void>
  tripRateChanged(n: RateNotice): Promise<void>
  tripEnded(n: TripNotice): Promise<void>
  tripReopened(n: TripNotice): Promise<void>
  linkReset(n: { chatId: number, groupId: number, actorName: string }): Promise<void>
  memberJoinedByLink(n: { chatId: number, memberName: string }): Promise<void>
}
```

- `ExpenseNotice`: chatId, actorName, expenseId, groupId, description, total (minor units, expense currency), currency, splitType, shares as a list of member name and amount in the expense currency.
- `SettlementNotice`: chatId, actorName, fromName, toName, amount (minor units, home currency), currency.
- `RateNotice`: chatId, actorName, homeCurrency, currency, rate, origin, expensesChanged.
- `TripNotice`: chatId, actorName, tripName.

Notifier functions never throw. A failure to post is logged by the implementation.

These changes are logged in activity and post no notice: adding a member by hand, claiming a member, renaming a trip, changing home currency, finishing setup, discarding or restoring a draft, saving a draft.

`RateSuggester = (from: string, to: string) => Promise<string | null>` returns the number of units of `to` equal to 1 unit of `from`. PRD 3b implements it. Tests pass a fake.

## Tests

Required cases, at minimum:

**Splitting and validation**
- Even, portions and items splits, each with amounts that do not divide exactly.
- Payer not included in the split.
- Item with nobody assigned. Item shared by two members.
- Item with quantity 2: amount is used as given and not multiplied.
- Items 100, tax 10 not included, discount 10, total 100: valid.
- Items 100 with tax included, service charge 10, total 110: valid.
- Zero-value items with a tip: refused.
- A taxi fare of 20.00 split evenly with no items: valid.
- Negative remainder from a discount, spread in proportion.

**Currency**
- 1124 JPY at 112.4 converts to exactly 10.00 SGD. 11240 JPY converts to 100.00 SGD.
- An SGD expense in a JPY-home trip.
- Shares that do not convert exactly: converted shares sum to the converted total.
- Balances across two currencies sum to zero.
- An unsupported currency is refused.
- Rate order: home, expense, trip, missing.
- `setTripRate` updates confirmed and draft expenses with source `trip` or `missing`, leaves source `expense` untouched, raises their versions and logs each.
- `setTripRate` with an out-of-date snapshot is refused.
- Saving an expense without `rateOverride` keeps a trip-derived rate as source `trip`.
- Changing an expense's currency clears its override.
- `changeHomeCurrency` clears rates and overrides and re-resolves drafts, and is refused once locked.
- The lock stays after the only confirmed expense is deleted.

**Settle-up**
- Ties, everyone already settled, one member owing several.

**Members**
- Claim with no overlap: other members' balances unchanged, survivor's balance is the sum.
- Claim where both share an expense: refused, listing the expense.
- Claim where the absorbed member had paid a third member: the settlement moves to the survivor.
- Claim with a settlement between the two: marked undone.

**Operations**
- Every operation called with a record from another group throws `NotFoundError` and changes nothing.
- A payer or share member from another group is refused.
- Stale version refused on save, confirm, discard, delete, restore and undo.
- A save with an old version after someone else changed shares is refused.
- Each operation writes the activity entries documented for it.
- UPDATE and DELETE on `activity` fail.
- `ensureGroup` called twice creates one group and one trip.
- `migrateChat` called twice leaves one alias. `findGroupByChatId` finds the group by old and new ID.
- Only settlements can be changed on an ended trip.
- `reserveReceiptRead` at the cap is refused, and the day changes at midnight Singapore time.

**Access and links**
- initData with a valid signature, a wrong signature, an expired date and a bot user.
- `resolveAccess`: an existing member, a new person joining by link, and a link from before a reset refused.
- `DEV_FAKE_USER` with `NODE_ENV=production` stops startup.
- `resetLink` raises the version and logs it.
- Launch encoding round trip, a tampered parameter, and output within Telegram's allowed characters and length.

## Done when

`pnpm install`, `pnpm typecheck`, `pnpm test` and `pnpm web:build` pass on a clean checkout, and `docs/foundation-api.md` lists every export with its signature.
