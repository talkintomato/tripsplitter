# PRD 2: Mini App core

Depends on PRD 0. Owns `src/api/` (except `auth.ts`), `web/` after the scaffold, `test/api/` and `test/web/`.

Read [README.md](README.md) and `docs/foundation-api.md` first. Use the operations and types from PRD 0 as they are. Anything missing is reported, not patched.

## Goal

The screens and the HTTP API for everything except the by-item split screen (PRD 4) and the currency screens (PRD 5).

Until PRD 5, the screens offer no way to choose a currency or enter a rate, so expenses created here are in the trip's home currency. Drafts created from receipts may be in a foreign currency, and normally already have a rate, looked up when the receipt was read. The screens show such a draft with its own currency and amount, the rate, and the converted amount.

Whenever an expense is created or saved with `fx_rate_source` coming back as `missing`, the API calls `deps.suggestRate(homeCurrency, expenseCurrency)`. If it returns a rate, the API calls `setTripRate` with origin `suggested`, which resolves the expense, and then `notifier.tripRateChanged`. Only if it returns null does the expense stay a draft, shown with the message "Couldn't look up an exchange rate. Enter one to save this." PRD 0's `confirmExpense` refuses it until then.

## API

Hono app exported from `src/api/index.ts` as `createApi(config, db, deps)`, where `deps` is `{ notifier: Notifier, suggestRate: RateSuggester }` from `src/core/contracts.ts`. This build does not import `src/bot/`. In tests the dependencies are fakes.

### Every request

- `Authorization: tma <initData>` and `X-Launch: <start parameter>`.
- Middleware calls `verifyInitData`, `decodeLaunch` and `resolveAccess`, and builds the `Scope` from the launch group and the resolved member. The acting member always comes from here and never from the request body.
- Access `none` gives 403, with a message that the link is no longer valid and to use the latest one pinned in the group.
- When `resolveAccess` creates a new member, `notifier.memberJoinedByLink` is called once.
- `NotFoundError` gives 404. `ValidationError` gives 400 with messages fit to show a member. `StaleEditError` gives 409 with the current record.

### Routes

Trip-scoped routes name the trip. The Mini App finds the trip to show through `GET /api/group`.

| Method and path | Purpose |
|---|---|
| `GET /api/group` | Group, members, access level, active trip or null, and the destination from the launch parameter |
| `GET /api/trips` | All trips of the group |
| `POST /api/trips` | Create the active trip when there is none |
| `GET /api/trips/:tripId` | One trip |
| `PATCH /api/trips/:tripId` | Rename, change home currency, mark setup done |
| `POST /api/trips/:tripId/end`, `/reopen` | End or reopen |
| `GET /api/trips/:tripId/expenses?status=` | List, including drafts |
| `POST /api/trips/:tripId/expenses` | Create, as a draft or confirmed |
| `GET /api/expenses/:id` | One expense with items, shares and each member's amount |
| `PUT /api/expenses/:id` | Save the whole expense |
| `POST /api/expenses/:id/confirm`, `/discard`, `/delete`, `/restore` | Status changes |
| `GET /api/trips/:tripId/balances` | Balances, suggested payments and recorded settlements |
| `POST /api/trips/:tripId/settlements` | Record a settlement |
| `POST /api/settlements/:id/undo`, `/restore` | Undo or restore |
| `POST /api/members` | Add a person by name |
| `POST /api/members/:id/claim` | The caller claims a hand-added member |
| `POST /api/group/reset-link` | Reset the group's link, then `notifier.linkReset` |
| `GET /api/activity?tripId=&before=` | Activity entries, newest first, 50 per page |

Every request that changes an existing expense or settlement carries `version` in its body, including confirm, discard, delete, restore and undo.

`POST` and `PUT` for expenses accept the full expense of PRD 0, including items, item shares, `tax_included` and the adjustment figures, and pass it to `createExpense` or `saveExpense`. The screens in this build send only even and portions splits. PRD 4 adds the screen that sends items.

### Notices

After a change commits, the matching `Notifier` function is called once. A notice failing does not fail the request. Changes that post no notice are listed in PRD 0.

| Change | Notice |
|---|---|
| Expense created as confirmed, or a draft confirmed | `expenseSaved` |
| Confirmed expense saved with changes | `expenseEdited` |
| Confirmed expense deleted, deleted expense restored | `expenseDeleted`, `expenseRestored` |
| Settlement recorded, undone, restored | the three settlement notices |
| Trip ended, reopened | `tripEnded`, `tripReopened` |

### Trip rules

- Ending a trip asks for confirmation in the screen.
- On an ended trip only settlements can be changed.
- A trip can be reopened only when the group has no active trip.
- When a trip is ended, no new trip is created straight away. Creating an expense when the group has no active trip creates one first.

### Claiming a member

`POST /api/members/:id/claim` calls `claimMember`. The caller is always already a member, so a claim always merges the hand-added member into the caller. When the claim is refused, for either reason the foundation gives, the response lists the expenses concerned and the screen shows them with the instruction to remove one of the two people from each.

`PATCH /api/trips/:tripId` may change several things at once. It runs the operations inside `inTransaction` so that either all apply or none.

## Screens

React with React Router, styled with Telegram theme variables so it matches light and dark mode. Works at 320px width.

On load the app reads the start parameter from the Telegram SDK, calls `GET /api/group`, and goes to the destination it returns: home, add expense, balances, or a given expense. An expense from an ended trip opens in that trip.

| Screen | Contents |
|---|---|
| Home | Trip name, the caller's balance, open drafts count, recent expenses, buttons for Add expense, Balances, Members, Activity. When there is no active trip: past trips and a Start new trip button. |
| Expense form | Description, amount, date (default today), payer (default the caller), split type switch, member list. Even: tick boxes, every active member ticked by default. Portions: a whole number per person. Items: shown and disabled until PRD 4. Used for create, edit and finishing a draft. |
| Expense detail | All fields, each person's amount, Edit, Delete |
| Drafts | Open drafts with Finish and Discard |
| Balances | Net balance per member and the suggested payments, each with Mark as paid. Recorded settlements with Undo. |
| Members | Active, inactive and hand-added members, showing who joined through the link. Add person. "That's me" on hand-added members. Reset link, with a confirmation explaining that old links stop working. |
| Activity | Who did what and when, newest first. Restore on deleted expenses, discarded drafts and undone settlements. |
| Past trips | Ended trips, read-only apart from settlements, with Reopen when allowed |

The expense form is built so that the body of each split type is its own component, chosen from a small registry keyed by split type. PRD 4 adds the items component to the registry without restructuring the form.

States to handle on every screen: loading, empty, error with retry, and the 409 "changed by someone else" case, which loads the current record and keeps the member's unsaved input visible for comparison.

Opening the Mini App without a valid start parameter, for example from the bot's private chat, shows a page explaining that it must be opened from the group's link.

## Tests

API tests with an in-memory database and fake dependencies:

- Each route with access and with a link from before a reset.
- A new person opening the link becomes a member and the notice is sent once.
- A record ID from another group gives 404 on every route that takes an ID, for reads and writes.
- A payer or share member from another group gives 400.
- The acting member cannot be set from the request body.
- Stale version refused on save, confirm, discard, delete, restore and undo.
- A foreign-currency draft with no rate cannot be confirmed.
- Home currency change before and after the lock.
- End trip, settle on the ended trip, refuse an expense on it, reopen.
- Settling an ended trip while a newer trip is active records against the ended trip.
- Claim that merges, claim refused for overlap, and claim refused because it would change amounts.
- A `PATCH` of a trip with one invalid field changes nothing.
- Restore of each kind.
- Activity pagination.
- Each change calls its notice once, changes without a notice call none, and a failing notice leaves the request successful.
- The launch destination is returned, and an expense destination from another group is refused.

Component tests for the expense form covering even and portions, and the 409 case.

## Done when

Tests and typecheck pass, `pnpm web:build` succeeds, and with the API running locally every screen works in a browser using `DEV_FAKE_USER`.
