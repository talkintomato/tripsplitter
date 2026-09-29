# Foundation API

What PRD 0 built, for the builds that come after it. Every export is listed with its signature. Read this instead of the source.

## Rules for later builds

- Import from the four entry points only:
  - `src/core/index.js`: money maths, currencies, rates, launch links, shared types
  - `src/db/index.js`: the database and its operations
  - `src/api/auth.js`: sign-in and access
  - `src/config.js`: configuration
- Do not import `src/db/internal.js` or any other file under `src/db/`. They are not part of the API.
- The Mini App (`web/`) cannot import `src/core/index.js`, because `launch.ts` needs `node:crypto`. It imports single files: `src/core/currencies.ts`, `src/core/contracts.ts`, `src/core/types.ts`, `src/core/amounts.ts`, `src/core/rates.ts`, `src/core/split.ts`, `src/core/balances.ts`, `src/core/settle.ts`. None of these needs Node.
- Server code is ESM with `moduleResolution: NodeNext`. Relative imports end in `.js`: `import { createExpense } from '../db/index.js'`. `pnpm typecheck` fails without the ending. Files under `web/` and `test/web/` use bundler resolution and leave the ending out.
- Every operation takes `db` first, then `scope`. The PRD writes `createExpense(scope, input)`; the real call is `createExpense(db, scope, input)`.
- Amounts in records and inputs are whole `number`s of minor units. Results of the arithmetic in `src/core` are `bigint`. Turn them into numbers for JSON with `toSafeNumber` or `amountsToRecord`. `JSON.stringify` throws on a `bigint`.

## Tooling

| Script | What it does |
|---|---|
| `pnpm dev` | `tsx watch src/main.ts`, reading `.env` when there is one. `src/main.ts` is written by PRD 5. |
| `pnpm build` | Compiles `src/` to `dist/`, copies the SQL migrations to `dist/db/migrations/`, builds the Mini App |
| `pnpm start` | `node dist/main.js`, reading `.env` when there is one |
| `pnpm test` | Everything under `test/`, files named `*.test.ts` or `*.test.tsx`, except `test/receipts/live/` and `test/fx/live/` |
| `pnpm test:receipts` | Only `test/receipts/live/**/*.test.ts`. Config: `vitest.receipts.config.ts`. Passes when the folder has no tests. |
| `pnpm test:fx` | Only `test/fx/live/**/*.test.ts`. Config: `vitest.fx.config.ts`. Passes when the folder has no tests. |
| `pnpm typecheck` | `tsconfig.json` (server and tests) then `web/tsconfig.json` (Mini App and `test/web/`) |
| `pnpm web:dev` | Vite dev server for the Mini App on port 5173, passing `/api` on to `localhost:3000` |
| `pnpm web:build` | Builds the Mini App into `web/dist/` |

Tests that need a DOM go in `test/web/` and start with the line `// @vitest-environment jsdom`. `jsdom`, `@testing-library/react`, `@testing-library/user-event` and `@testing-library/jest-dom` are installed.

Tests get a database with `openDatabase(':memory:')` and a config with `buildConfig()`.

## Configuration: `src/config.ts`

| Export | Description |
|---|---|
| `interface Config` | `botToken`, `botUsername`, `miniAppName`, `allowedChatIds: number[]`, `linkSecret`, `databasePath`, `openaiApiKey: string \| undefined`, `receiptModel`, `receiptDailyCap: number`, `receiptGlobalDailyCap: number`, `port: number`, `nodeEnv: 'development' \| 'test' \| 'production'`, `devFakeUser: DevFakeUser \| undefined`, `webhookUrl: string \| undefined`, `webhookSecret: string \| undefined` |
| `interface DevFakeUser` | `{ id: number; firstName: string; lastName?: string; username?: string }`. Same shape as `TelegramUser`. |
| `loadConfig(env?: Record<string, string \| undefined>): Config` | Reads and checks the environment, `process.env` by default. Throws `ConfigError` naming every missing or invalid variable. |
| `buildConfig(overrides?: Partial<Config>): Config` | A config for tests, without any environment variable. `nodeEnv` is `test`, `databasePath` is `:memory:`. |
| `class ConfigError extends Error` | `variables: string[]` names the variables at fault. |
| `receiptReadingEnabled(config: Config): boolean` | True when `OPENAI_API_KEY` is set. |
| `isChatIdListed(config: Config, chatId: number): boolean` | True when this exact ID is in `ALLOWED_CHAT_IDS`. Earlier IDs of an upgraded chat are not looked at; PRD 1's `isAllowedChat` does that with `group.previousChatIds`. |

Variables: `NODE_ENV` (default `development`), `BOT_TOKEN`, `BOT_USERNAME` (no `@`), `MINI_APP_NAME`, `ALLOWED_CHAT_IDS`, `LINK_SECRET` (at least 32 characters), `DATABASE_PATH` (default `./data/tripsplitter.db`), `OPENAI_API_KEY` (optional), `RECEIPT_MODEL` (default `gpt-6-luna`), `RECEIPT_DAILY_CAP` (default 30), `RECEIPT_GLOBAL_DAILY_CAP` (default 300; 0 disables the overall limit), `PORT` (default 3000), `WEBHOOK_URL` (optional), `WEBHOOK_SECRET` (16 to 256 letters, digits, `_` or `-`; required when `WEBHOOK_URL` is set), `DEV_FAKE_USER` (JSON such as `{"id":1,"first_name":"Dev"}`; loading fails when it is set in production). A blank value counts as not set.

## Money maths: `src/core/`

Pure functions. No database, no floating point.

### Types: `types.ts`

| Export | Description |
|---|---|
| `type SplitType = 'even' \| 'portions' \| 'items'` | How an expense is divided. |
| `type Amount = number \| bigint` | Minor units. A `number` must be a safe integer. |
| `interface SplitExpense` | `{ payerId: number; total: Amount; tax: Amount; taxIncluded: boolean; tip: Amount; serviceCharge: Amount; discount: Amount; splitType: SplitType }` |
| `interface SplitItem` | `{ id: number; amount: Amount; quantity?: number }`. `amount` is the line total. `quantity` is ignored. For an unsaved expense use the line's index as `id`. |
| `interface SplitShare` | `{ memberId: number; weight: number; expenseId?: number \| null; itemId?: number \| null }`. `itemId` null or missing: the member is included in the expense. `itemId` set: assigned to that item. |
| `interface ExpenseProblem` | `{ field: ProblemField; code: ProblemCode; message: string; difference?: number }`. `difference` only with `total_mismatch`: total minus expected total. |
| `type ProblemField` | `'total' \| 'tax' \| 'tip' \| 'serviceCharge' \| 'discount' \| 'shares' \| 'items' \| 'fxRate' \| 'currency'` |
| `type ProblemCode` | `'total_not_positive' \| 'invalid_amount' \| 'no_members' \| 'invalid_weight' \| 'duplicate_member' \| 'no_items' \| 'unknown_item' \| 'member_not_included' \| 'total_mismatch' \| 'zero_items_with_adjustments' \| 'rate_missing' \| 'rate_invalid' \| 'currency_needs_review'` |
| `class InvalidExpenseError extends Error` | `problems: ExpenseProblem[]`. Thrown by `computeShares`, `convertExpense` and `computeBalances`. |
| `interface BalanceExpense extends SplitExpense` | Adds `id`, `status: string`, `currency: string`, `fxRate: string \| null`, `items: SplitItem[]`, `shares: SplitShare[]`. An `ExpenseDetail` fits. |
| `interface BalanceSettlement` | `{ fromMemberId: number; toMemberId: number; amount: Amount; status: string }`. A `Settlement` fits. |
| `interface Payment` | `{ fromMemberId: number; toMemberId: number; amount: bigint }` |

### Amounts: `amounts.ts`

| Export | Description |
|---|---|
| `isAmount(value: unknown): value is Amount` | True for a bigint or a safe integer. |
| `toBigInt(value: Amount): bigint` | Throws RangeError for a number that is not a safe integer. |
| `toSafeNumber(value: Amount): number` | A bigint as number, for JSON. Throws RangeError when it does not fit. |
| `amountsToRecord(amounts: ReadonlyMap<number, Amount>): Record<number, number>` | A map per member as a plain object, for JSON. |

### Currencies: `currencies.ts`

| Export | Description |
|---|---|
| `const CURRENCIES` | The supported list, each `{ code, name, decimals }`: SGD, MYR, THB, CNY, USD, GBP, AUD, NZD, EUR with 2 decimals; IDR, JPY, KRW with 0. The only place currencies are defined. |
| `interface Currency` | `{ code: string; name: string; decimals: number }` |
| `type CurrencyCode` | Union of the supported codes. |
| `const DEFAULT_HOME_CURRENCY: CurrencyCode` | `'SGD'` |
| `isSupportedCurrency(code: unknown): code is CurrencyCode` | Case-sensitive. |
| `getCurrency(code: string): Currency` | Throws `UnsupportedCurrencyError`. |
| `currencyDecimals(code: string): number` | Throws `UnsupportedCurrencyError`. |
| `toMinorUnits(amountString: string, code: string): number` | `"84.50"` to 8450 for SGD, `"1200"` to 1200 for JPY. Throws RangeError for anything that is not a plain decimal string, including a number, a sign or a comma, and for more decimals than the currency has. Throws `UnsupportedCurrencyError`. |
| `fromMinorUnits(minor: Amount, code: string): string` | 8450 to `"84.50"`. |
| `formatAmount(minor: Amount, code: string): string` | 8450 to `"84.50 SGD"`, 1200 to `"1200 JPY"`. |
| `class UnsupportedCurrencyError extends Error` | `currency: string` |

### Rates: `rates.ts`

A rate is a decimal string above zero with at most 6 decimal places, kept exactly as entered. It is the number of units of the expense currency equal to 1 unit of home currency: `"112.4"` means 1 SGD = 112.4 JPY.

| Export | Description |
|---|---|
| `type RateSource = 'home' \| 'expense' \| 'trip' \| 'missing'` | Where an expense's rate came from. |
| `interface ResolvedRate` | `{ rate: string \| null; source: RateSource }`. `rate` is null only for `missing`. |
| `interface ResolveRateInput` | `{ expenseCurrency: string; homeCurrency: string; expenseOverride?: string \| null; tripRate?: string \| null }` |
| `const RATE_MAX_DECIMALS = 6` | |
| `isValidRate(value: unknown): value is string` | |
| `resolveRate(input: ResolveRateInput): ResolvedRate` | Order: home (rate `"1"`), expense override, trip rate, missing. Throws RangeError for a rate that is given but not valid. |
| `convertToHome(expenseMinor: Amount, rate: string, expenseCurrency: string, homeCurrency: string, rounding: 'down' \| 'half-up'): bigint` | `expenseMinor × 10^homeDecimals / (rate × 10^expenseDecimals)` as an exact fraction. 1124 JPY at `"112.4"` is 1000 SGD minor units. |

### Splitting: `split.ts`

| Export | Description |
|---|---|
| `validateExpense(expense: SplitExpense, items: ReadonlyArray<SplitItem>, shares: ReadonlyArray<SplitShare>): ExpenseProblem[]` | Everything that stops the expense from being confirmed. Empty when fine. Never throws. |
| `computeShares(expense: SplitExpense, items: ReadonlyArray<SplitItem>, shares: ReadonlyArray<SplitShare>): Map<number, bigint>` | Each included member's amount in the expense currency. Sums to the total. Throws `InvalidExpenseError` when `validateExpense` reports a problem. |
| `itemsDifference(expense: SplitExpense, items: ReadonlyArray<Pick<SplitItem, 'amount'>>): bigint` | Total minus expected total for an items split. |

Expected total = items + tip + service charge - discount + (tax when `taxIncluded` is false).

### Balances: `balances.ts`

| Export | Description |
|---|---|
| `convertExpense(expense: { payerId: number; total: Amount; currency: string; fxRate: string \| null }, shares: ReadonlyMap<number, Amount>, homeCurrency: string): ConvertedExpense` | Total rounded half up, shares rounded down, leftover to the payer if included, otherwise to the lowest ID. Throws `InvalidExpenseError` without a valid rate. |
| `interface ConvertedExpense` | `{ total: bigint; shares: Map<number, bigint> }`, in home currency. |
| `computeBalances(expenses: ReadonlyArray<BalanceExpense>, settlements: ReadonlyArray<BalanceSettlement>, homeCurrency: string): Map<number, bigint>` | Positive: is owed money. Only confirmed expenses and active settlements count. Sums to zero. |

### Settle-up: `settle.ts`

| Export | Description |
|---|---|
| `suggestPayments(balances: ReadonlyMap<number, Amount>): Payment[]` | Greedy matching, ties to the lowest ID, at most N-1 payments. |

### Merging members: `merge.ts`

Used by `claimMember`. Later builds call `claimMember`, not this.

| Export | Description |
|---|---|
| `planMerge(survivorId: number, absorbedId: number, records: MergeRecords): MergePlan` | The changes needed to fold one member into another. Changes nothing itself. |
| `interface MergeRecords` | `{ expenses, shares, settlements, tripRates }` of the group. |
| `interface MergePlan` | `{ survivorId, absorbedId, overlappingExpenseIds, shareIds, payerExpenseIds, creatorExpenseIds, touchedExpenseIds, settlements, tripRateIds }` |

### Links into the Mini App: `launch.ts`

| Export | Description |
|---|---|
| `type LaunchView = 'home' \| 'add' \| 'balances' \| 'expense'` | |
| `const LAUNCH_VIEWS: readonly LaunchView[]` | |
| `interface Launch` | `{ groupId: number; linkVersion: number; view: LaunchView; expenseId?: number }`. `expenseId` only with view `expense`, and required there. |
| `encodeLaunch(launch: Launch, secret: string): string` | `v1_<groupId>_<linkVersion>_<view>_<expenseId or 0>_<signature>`. Throws RangeError for a launch that cannot be encoded. |
| `decodeLaunch(param: string, secret: string): Launch` | Checks form and signature. Throws `LaunchError`. Does not check the link version; `resolveAccess` does. |
| `launchUrl(config: { botUsername: string; miniAppName: string; linkSecret: string }, launch: Launch): string` | `https://t.me/<bot>/<app>?startapp=<param>`. Pass a `Config`. |
| `class LaunchError extends Error` | `reason: 'format' \| 'signature'`. Map to HTTP 401. |
| `const LAUNCH_MAX_LENGTH = 512` | |

Build a launch from the group: `{ groupId: group.id, linkVersion: group.linkVersion, view: 'add' }`.

### Shared types: `contracts.ts`

Types only.

| Export | Description |
|---|---|
| `interface Notifier` | `expenseSaved(n: ExpenseNotice)`, `expenseEdited(n: ExpenseNotice & { changes: string[] })`, `expenseDeleted(n: ExpenseNotice)`, `expenseRestored(n: ExpenseNotice)`, `settlementRecorded(n: SettlementNotice)`, `settlementUndone(n: SettlementNotice)`, `settlementRestored(n: SettlementNotice)`, `tripRateChanged(n: RateNotice)`, `tripEnded(n: TripNotice)`, `tripReopened(n: TripNotice)`, `linkReset(n: LinkResetNotice)`, `memberJoinedByLink(n: MemberJoinedNotice)`. Each returns `Promise<void>` and never throws. |
| `interface ExpenseNotice` | `{ chatId: number; actorName: string; expenseId: number; groupId: number; description: string; total: Amount; currency: string; splitType: SplitType; shares: NoticeShare[] }` |
| `interface NoticeShare` | `{ name: string; amount: Amount }`, in the expense currency. |
| `interface SettlementNotice` | `{ chatId: number; actorName: string; fromName: string; toName: string; amount: Amount; currency: string }`, in home currency. |
| `interface RateNotice` | `{ chatId: number; actorName: string; homeCurrency: string; currency: string; rate: string; origin: RateOrigin; expensesChanged: number }` |
| `interface TripNotice` | `{ chatId: number; actorName: string; tripName: string }` |
| `interface LinkResetNotice` | `{ chatId: number; groupId: number; actorName: string }` |
| `interface MemberJoinedNotice` | `{ chatId: number; memberName: string }` |
| `type RateOrigin = 'suggested' \| 'member'` | |
| `type RateSuggester = (from: string, to: string) => Promise<string \| null>` | Units of `to` equal to 1 unit of `from`. Call it with the home currency as `from` and the expense currency as `to`. Implemented by PRD 3b. |

`ExpenseNotice.shares` is built with `computeShares(detail, detail.items, detail.shares)` and the members' display names.

## Database: `src/db/`

### Opening

| Export | Description |
|---|---|
| `type Db` | An open `better-sqlite3` database. |
| `openDatabase(path: string, options?: OpenDatabaseOptions): Db` | Opens the file or `:memory:`, turns on WAL mode and foreign keys, applies migrations, fills the `currency` table. Creates the folder of the file. |
| `interface OpenDatabaseOptions` | `{ migrationsDir?: string; migrate?: boolean }` |
| `migrate(db: Db, migrationsDir?: string): string[]` | Applies pending migration files in order. Returns their names. |
| `inTransaction<T>(db: Db, fn: () => T): T` | Runs several operations as one transaction. `fn` must not be async. |
| `now(): Date`, `nowIso(): string` | The clock that stamps records. |
| `setClockForTests(fn: (() => Date) \| null): void` | Replaces that clock. Null restores it. |
| `singaporeDate(moment?: Date): string` | The Singapore date of a moment, `YYYY-MM-DD`. |

The PRD's table `group` is named `chat_group`, because `GROUP` is a reserved word in SQL. There is one extra table, `currency`, filled from `CURRENCIES`, which the currency columns reference.

### Scope and actor

| Export | Description |
|---|---|
| `type Actor = { kind: 'member'; memberId: number } \| { kind: 'system' }` | |
| `interface Scope` | `{ groupId: number; actor: Actor }` |
| `const SYSTEM_ACTOR: Actor` | `{ kind: 'system' }` |
| `systemScope(groupId: number): Scope` | For changes made by Telegram events or the bot itself. |
| `memberScope(groupId: number, memberId: number): Scope` | For changes made by a person. |

Rules every operation follows:

- The group of the scope must exist, else `NotFoundError`.
- A member actor must belong to the group, else `PermissionError`. To change data it must also not have been merged away. Being inactive does not limit anything.
- A record whose chain does not end at `scope.groupId` throws `NotFoundError`, exactly as a missing record does.
- A member ID in the input must belong to the group and not be merged away, else `ValidationError` with code `member_not_in_group`.
- A change and its activity entries commit together. A refused call changes nothing and writes nothing.
- `createExpense`, `createSettlement` and `claimMember` need a member as actor. With the system actor they throw `PermissionError`.

### Errors

| Export | HTTP | Description |
|---|---|---|
| `class DomainError extends Error` | | Base of the four below. `message` is fit to show a member. |
| `class NotFoundError` | 404 | `entityType: string`, `entityId: number \| string` |
| `class ValidationError` | 400 | `code: ValidationCode`, `problems: ExpenseProblem[]`, `expenses: ExpenseRef[]` |
| `class StaleEditError<T>` | 409 | `entityType: 'expense' \| 'settlement' \| 'trip_rate'`, `entityId: number`, `current: T`. `current` is an `ExpenseDetail`, a `Settlement`, or for a trip rate a fresh `TripRatePreview`. |
| `class PermissionError` | 403 | |
| `type ValidationCode` | | `'invalid_input' \| 'invalid_expense' \| 'unsupported_currency' \| 'member_not_in_group' \| 'invalid_status' \| 'trip_ended' \| 'active_trip_exists' \| 'home_currency_locked' \| 'rate_missing' \| 'currency_needs_review' \| 'claim_overlap' \| 'claim_changes_amounts'` |
| `interface ExpenseRef` | | `{ id, tripId, description, merchant, expenseDate, total, currency, status }` |

Operations on an existing expense or settlement check in this order: record exists in the group, actor may write, trip not ended (expenses only), status allows the change (`invalid_status`), version matches (`StaleEditError`), then everything else. So a second tap on a button whose draft is already confirmed gets `invalid_status`, and a tap with an old version on a draft that is still a draft gets `StaleEditError`.

### Records

| Export | Fields |
|---|---|
| `interface Group` | `id`, `chatId`, `previousChatIds: number[]`, `title`, `introMessageId: number \| null`, `linkVersion`, `createdAt` |
| `interface Member` | `id`, `groupId`, `telegramUserId: number \| null`, `displayName`, `username: string \| null`, `active: boolean`, `joinedVia: JoinedVia`, `mergedInto: number \| null`, `createdAt` |
| `interface Trip` | `id`, `groupId`, `name`, `homeCurrency: CurrencyCode`, `homeCurrencyLocked: boolean`, `status: TripStatus`, `setupDone: boolean`, `createdAt`, `endedAt: string \| null` |
| `interface TripFxRate` | `id`, `tripId`, `currency: CurrencyCode`, `rate: string`, `origin: RateOrigin`, `setBy: number \| null`, `updatedAt` |
| `interface Expense` | `id`, `tripId`, `createdBy`, `payerId`, `description`, `merchant: string \| null`, `expenseDate` (`YYYY-MM-DD`), `total`, `tax`, `taxIncluded: boolean`, `tip`, `serviceCharge`, `discount`, `currency: CurrencyCode`, `currencyNeedsReview: boolean`, `fxRate: string \| null`, `fxRateSource: RateSource`, `splitType: SplitType`, `receiptFileId: string \| null`, `status: ExpenseStatus`, `statusBeforeRemoval: 'draft' \| 'confirmed' \| null`, `version`, `createdAt`, `updatedAt` |
| `interface ExpenseItem` | `id`, `expenseId`, `label`, `quantity`, `amount` (line total), `position` |
| `interface Share` | `id`, `memberId`, `weight`, `expenseId: number \| null`, `itemId: number \| null` |
| `interface ExpenseDetail extends Expense` | Adds `items: ExpenseItem[]` and `shares: Share[]`. `shares` holds both kinds: included in the expense (`itemId` null) and assigned to an item. |
| `interface Settlement` | `id`, `tripId`, `createdBy`, `fromMemberId` (paid), `toMemberId` (was paid), `amount` (home currency), `status: SettlementStatus`, `version`, `createdAt` |
| `interface Activity` | `id`, `groupId`, `tripId: number \| null`, `actor: Actor`, `action: ActivityAction`, `entityType: ActivityEntityType`, `entityId`, `before: unknown`, `after: unknown`, `createdAt` |
| `type JoinedVia` | `'chat' \| 'link' \| 'manual'` |
| `type TripStatus` | `'active' \| 'ended'` |
| `type ExpenseStatus` | `'draft' \| 'confirmed' \| 'discarded' \| 'deleted'` |
| `type SettlementStatus` | `'active' \| 'undone'` |
| `type ActivityEntityType` | `'group' \| 'member' \| 'trip' \| 'trip_rate' \| 'expense' \| 'settlement'` |
| `type ActivityAction` | Every action named in the "Activity" column of the tables below. |
| `type CurrencyCode`, `RateOrigin`, `RateSource`, `SplitType` | The same types as in `src/core`. |

Timestamps are ISO 8601 text in UTC.

### Inputs

| Export | Fields |
|---|---|
| `interface TelegramProfile` | `{ telegramUserId: number; displayName: string; username?: string \| null }` |
| `interface ShareInput` | `{ memberId: number; weight?: number }`. Weight defaults to 1. |
| `interface ExpenseItemInput` | `{ label: string; quantity?: number; amount: number; shares?: ShareInput[] }`. `shares` are the members assigned to the item. Empty or missing: shared by everyone included. |
| `interface ExpenseInput` | See below. |
| `interface CreateExpenseInput extends ExpenseInput` | Adds `tripId: number` and `status?: 'draft' \| 'confirmed'` (default `confirmed`). |

`ExpenseInput`, the whole expense:

| Field | Required | Left out on create | Left out on save |
|---|---|---|---|
| `payerId: number` | yes | | |
| `expenseDate: string` | yes | | |
| `total: number` | yes | | |
| `splitType: SplitType` | yes | | |
| `shares: ShareInput[]` | yes | | |
| `description?: string` | | empty | empty |
| `merchant?: string \| null` | | null | null |
| `tax?`, `tip?`, `serviceCharge?`, `discount?: number` | | 0 | 0 |
| `taxIncluded?: boolean` | | false | false |
| `items?: ExpenseItemInput[]` | | none | none |
| `currency?: string` | | the trip's home currency | keeps the currency |
| `currencyNeedsReview?: boolean` | | false | cleared when `currency` is given in the same call, otherwise kept |
| `rateOverride?: string \| null` | | no rate of its own | keeps what the expense had |
| `receiptFileId?: string \| null` | | null | keeps it |

A save replaces the whole expense, so a field left out goes back to its default. The last four rows are the exceptions. The form must send back every field it loaded.

`rateOverride`: a string gives the expense its own rate, `null` clears it and returns the expense to the trip rate. Changing the currency clears it unless a new one is given in the same call. It is ignored for the home currency. `fxRate` and `fxRateSource` are never read from the input.

### Group operations

| Operation | Activity |
|---|---|
| `ensureGroup(db: Db, chatId: number, title: string, humans: TelegramProfile[]): EnsureGroupResult`<br>Creates the group, a member per human (joined via `chat`) and a first trip in SGD, with the system actor. An existing group, found by current or earlier chat ID, is returned unchanged. Never pass a bot. | `group.create`, one `member.add` per human, `trip.create`. None when the group existed. |
| `interface EnsureGroupResult` `{ group: Group; created: boolean; members: Member[]; trip: Trip \| null }` | |
| `migrateChat(db: Db, oldChatId: number, newChatId: number): Group`<br>Sets the new chat ID and keeps the old one as an earlier ID. Safe to call twice. Throws `NotFoundError` when no group has either ID. | `group.migrate`, system actor. None the second time. |
| `findGroupByChatId(db: Db, chatId: number): Group \| undefined`<br>Matches the current ID or an earlier one. | |
| `getGroup(db: Db, scope: Scope): Group` | |
| `setIntroMessage(db: Db, scope: Scope, messageId: number \| null): Group` | `group.intro_message`. None when unchanged. |
| `renameGroup(db: Db, scope: Scope, title: string): Group`<br>For when the chat is renamed. Not in the PRD's list. | `group.rename`. None when unchanged. |
| `resetLink(db: Db, scope: Scope): Group`<br>Adds 1 to `linkVersion`. Links made before stop working. Members stay. | `group.link_reset` |

### Member operations

| Operation | Activity |
|---|---|
| `upsertTelegramMember(db: Db, scope: Scope, profile: TelegramProfile, options?: { joinedVia?: 'chat' \| 'link' }): UpsertMemberResult`<br>Adds a Telegram user, or updates name and username and marks them active. Matched by Telegram user ID. `joinedVia` (default `chat`) is set when the member is created and not changed later. For every message the bot sees. | `member.add` when created, `member.activate` when an inactive member became active, `member.update` when only name or username changed. None otherwise. |
| `interface UpsertMemberResult` `{ member: Member; created: boolean; changed: boolean }` | |
| `setMemberActive(db: Db, scope: Scope, memberId: number, active: boolean): Member`<br>Inactive only means left out of new splits by default. | `member.activate` or `member.deactivate`. None when unchanged. |
| `addManualMember(db: Db, scope: Scope, displayName: string): Member` | `member.add` |
| `claimMember(db: Db, scope: Scope, manualMemberId: number): ClaimResult`<br>The acting member, who must have a Telegram account, absorbs a hand-added member. See below. | `member.claim`, then one `expense.member_merged` per expense touched, one `settlement.member_merged` per settlement touched, one `trip_rate.member_merged` per trip rate touched |
| `interface ClaimResult` `{ survivor: Member; absorbed: Member; expenses: ExpenseDetail[]; settlements: Settlement[] }` | |
| `listMembers(db: Db, scope: Scope, options?: { includeMerged?: boolean; activeOnly?: boolean }): Member[]`<br>Ordered by name. Absorbed members are left out unless `includeMerged`. `activeOnly` gives the people to tick by default. | |
| `getMember(db: Db, scope: Scope, memberId: number): Member` | |
| `findMemberByTelegramId(db: Db, scope: Scope, telegramUserId: number): Member \| undefined` | |

`claimMember` refuses, with `ValidationError` and nothing changed:

- `claim_overlap`: both have a share on the same expense or the same item, in any trip, whatever the status of the expense. `error.expenses` lists them. The message is "Remove one of the two from these expenses first".
- `claim_changes_amounts`: on a confirmed or deleted expense the merge would move a rounding difference onto someone else. `error.expenses` lists them. This can only happen when the hand-added member had the lowest ID in a split whose payer is not included.
- `invalid_status`: the target has a Telegram account, was claimed already, or is the actor.
- `invalid_input`: the actor has no Telegram account.

### Trip operations

| Operation | Activity |
|---|---|
| `getActiveTrip(db: Db, scope: Scope): Trip \| undefined` | |
| `getOrCreateActiveTrip(db: Db, scope: Scope): { trip: Trip; created: boolean }`<br>A new trip is named after the group and copies the home currency of the most recent trip. | `trip.create` when created |
| `getTrip(db: Db, scope: Scope, tripId: number): Trip` | |
| `listTrips(db: Db, scope: Scope, options?: { status?: TripStatus }): Trip[]`<br>Newest first. | |
| `renameTrip(db: Db, scope: Scope, tripId: number, name: string): Trip` | `trip.rename`. None when unchanged. |
| `changeHomeCurrency(db: Db, scope: Scope, tripId: number, currency: string): ChangeHomeCurrencyResult`<br>Removes every trip rate, clears every expense's own rate, re-resolves every expense to `home` or `missing`. Refused with `home_currency_locked` once locked. | `trip.home_currency`, one `trip_rate.remove` per rate, one `expense.rate_change` per expense changed. None when unchanged. |
| `interface ChangeHomeCurrencyResult` `{ trip: Trip; changed: boolean; removedRates: TripFxRate[]; changedExpenses: ExpenseDetail[] }` | |
| `completeSetup(db: Db, scope: Scope, tripId: number): Trip` | `trip.setup_done`. None when done already. |
| `endTrip(db: Db, scope: Scope, tripId: number): Trip` | `trip.end` |
| `reopenTrip(db: Db, scope: Scope, tripId: number): Trip`<br>Refused with `active_trip_exists` when the group has an active trip. | `trip.reopen` |

On an ended trip every operation that changes an expense, a trip rate or the trip itself throws `ValidationError` with code `trip_ended`. Creating, undoing and restoring settlements and `reopenTrip` still work.

### Rate operations

| Operation | Activity |
|---|---|
| `listTripRates(db: Db, scope: Scope, tripId: number): TripFxRate[]`<br>Ordered by currency. | |
| `setTripRate(db: Db, scope: Scope, tripId: number, currency: string, rate: string, origin: RateOrigin, expectedSnapshot?: string): SetTripRateResult`<br>Writes the rate and re-resolves every expense of the trip in that currency with source `trip` or `missing`, whatever its status. Expenses with source `expense` are untouched. Each changed expense gets version + 1. With an `expectedSnapshot` that no longer matches: `StaleEditError`. | `trip_rate.set` the first time or `trip_rate.change`, then one `expense.rate_change` per expense changed. None when rate and origin are unchanged. |
| `interface SetTripRateResult` `{ tripRate: TripFxRate; previous: TripFxRate \| null; changed: boolean; changedExpenses: ExpenseDetail[] }` | |
| `previewTripRate(db: Db, scope: Scope, tripId: number, currency: string, rate: string): TripRatePreview`<br>Changes nothing. | none |
| `interface TripRatePreview` `{ currentRate: TripFxRate \| null; expensesChanged: number; confirmedExpensesChanged: number; balancesBefore: Record<number, number>; balancesAfter: Record<number, number>; snapshot: string }` | |

A trip rate cannot be removed, only changed. There is no operation that removes one. `changeHomeCurrency` removes them all.

For `RateNotice.expensesChanged` use `result.changedExpenses.length`.

### Expense operations

| Operation | Activity |
|---|---|
| `createExpense(db: Db, scope: Scope, input: CreateExpenseInput): ExpenseDetail`<br>The actor becomes `createdBy`. With status `confirmed` it must pass every check of `confirmExpense`, and the home currency is locked. | `expense.create` |
| `getExpense(db: Db, scope: Scope, expenseId: number): ExpenseDetail`<br>Any status. | |
| `listExpenses(db: Db, scope: Scope, tripId: number, options?: { status?: ExpenseStatus \| ExpenseStatus[] }): ExpenseDetail[]`<br>Newest date first. Without `status`: drafts and confirmed. | |
| `saveExpense(db: Db, scope: Scope, expenseId: number, expectedVersion: number, input: ExpenseInput): ExpenseDetail`<br>Replaces fields, items and shares. Only a draft or confirmed expense. A confirmed one must stay valid. | `expense.save` |
| `confirmExpense(db: Db, scope: Scope, expenseId: number, expectedVersion: number): ExpenseDetail`<br>Draft to confirmed. Locks the home currency. | `expense.confirm` |
| `discardExpense(db: Db, scope: Scope, expenseId: number, expectedVersion: number): ExpenseDetail`<br>Draft to discarded. | `expense.discard` |
| `deleteExpense(db: Db, scope: Scope, expenseId: number, expectedVersion: number): ExpenseDetail`<br>Confirmed to deleted. | `expense.delete` |
| `restoreExpense(db: Db, scope: Scope, expenseId: number, expectedVersion: number): ExpenseDetail`<br>Discarded to draft, deleted to confirmed. The second runs the checks of `confirmExpense`. | `expense.restore` |
| `findPossibleDuplicates(db: Db, scope: Scope, tripId: number, match: { merchant: string \| null; total: number; currency: string; expenseDate: string; excludeId?: number }): Expense[]`<br>Confirmed expenses and open drafts with the same total, currency, date, and merchant ignoring case and spacing. | |

`confirmExpense` refuses with `ValidationError`, first match wins:

| Code | When |
|---|---|
| `trip_ended` | The trip has ended |
| `invalid_status` | The expense is not a draft |
| (`StaleEditError`) | The version is old |
| `currency_needs_review` | `currencyNeedsReview` is true |
| `rate_missing` | `fxRateSource` is `missing` |
| `invalid_expense` | `validateExpense` reports a problem |

For the last three, `error.problems` lists everything found, not only the first.

A draft may be incomplete: no shares, a total of zero, items that do not add up. It must still have acceptable values: whole amounts of zero or more, a real date, a supported currency, members of the group, and item members who are included in the expense.

### Settlement operations

| Operation | Activity |
|---|---|
| `createSettlement(db: Db, scope: Scope, input: { tripId: number; fromMemberId: number; toMemberId: number; amount: number }): Settlement`<br>`amount` in home currency, above zero. Works on an ended trip. Locks the home currency. | `settlement.create` |
| `undoSettlement(db: Db, scope: Scope, settlementId: number, expectedVersion: number): Settlement` | `settlement.undo` |
| `restoreSettlement(db: Db, scope: Scope, settlementId: number, expectedVersion: number): Settlement`<br>Refused with `invalid_status` for a settlement that a claim turned into one from a member to themselves. | `settlement.restore` |
| `listSettlements(db: Db, scope: Scope, tripId: number, options?: { status?: SettlementStatus }): Settlement[]`<br>Newest first. Without `status`: active and undone. | |
| `getSettlement(db: Db, scope: Scope, settlementId: number): Settlement` | |

### Balances

| Operation | Description |
|---|---|
| `getTripBalances(db: Db, scope: Scope, tripId: number): TripBalances` | Recomputed on every call. Works for ended trips. |
| `interface TripBalances` | `{ trip: Trip; balances: Record<number, number>; payments: Array<{ fromMemberId: number; toMemberId: number; amount: number }> }`. Plain numbers, ready for JSON. `balances` holds the members who took part in something; a member missing from it has a balance of 0. |

### Activity

| Operation | Description |
|---|---|
| `listActivity(db: Db, scope: Scope, options?: ListActivityOptions): Activity[]` | Newest first. |
| `interface ListActivityOptions` | `{ tripId?: number; before?: number; limit?: number; entity?: { type: 'expense' \| 'settlement'; id: number } }`. `before` is the ID of the last entry of the previous page. `limit` defaults to 50, at most 200. `entity` keeps only the entries about that one expense or settlement, including those written by other operations that changed it (a trip rate change, a member merge); a record of another group throws `NotFoundError`. |

There is no operation that writes, changes or removes an entry. Triggers refuse UPDATE and DELETE on the table.

`before` and `after` hold the whole record as JSON: a `Group`, `Member`, `Trip`, `TripFxRate`, `Settlement`, or for expenses an `ExpenseDetail` with items and shares. `member.claim` holds `{ survivor, absorbed }` before and `{ survivor, absorbed, expenseIds, settlementIds }` after. A creation has `before` null. `trip_rate.remove` has `after` null.

To restore from the Activity screen, read `entityType` and `entityId` from the entry, load the record, and call `restoreExpense` or `restoreSettlement` with its current version.

### Receipt cap

| Operation | Activity |
|---|---|
| `reserveReceiptRead(db: Db, groupId: number, cap: number, now: Date, globalCap?: number): boolean`<br>In one immediate transaction, counts the group's reservations for the Singapore day of `now` and adds one when the count is below `cap` and the total across all groups is below `globalCap`. Omitting `globalCap`, or passing 0, disables only the overall limit; a per-group `cap` of 0 still refuses every read. Reservations include retries and failed reads. Returns whether it reserved a read. Takes a group ID, not a scope. | none |
| `countReceiptReads(db: Db, groupId: number, now: Date): number` | |

## Access: `src/api/auth.ts`

| Export | Description |
|---|---|
| `interface TelegramUser` | `{ id: number; firstName: string; lastName?: string; username?: string; languageCode?: string }` |
| `verifyInitData(initData: string, botToken: string, now: Date): TelegramUser` | Checks Telegram's signature. Throws `InitDataError`. |
| `authenticate(config: Config, initData: string \| null \| undefined, now: Date): TelegramUser` | `verifyInitData` with `config.botToken`. When `config.nodeEnv` is `development` and `config.devFakeUser` is set, returns that user without any check. The API calls this one. |
| `class InitDataError extends Error` | `reason: InitDataFailure`. Map to HTTP 401. |
| `type InitDataFailure` | `'malformed' \| 'bad_signature' \| 'expired' \| 'bot'` |
| `const INIT_DATA_MAX_AGE_SECONDS` | 86400 |
| `displayNameOf(user: TelegramUser): string` | First and last name, else the username, else `User <id>`. |
| `resolveAccess(db: Db, telegramUser: TelegramUser, launch: Launch): AccessResult` | See below. Not async. |
| `interface AccessResult` | `{ level: AccessLevel; member?: Member; group?: Group; joined: boolean }` |
| `type AccessLevel` | `'write' \| 'none'` |

`resolveAccess`:

1. The group of the launch does not exist, or `launch.linkVersion` is not the group's `linkVersion`: `none`.
2. The Telegram user is a member of the group, active or not: `write`.
3. Otherwise the user becomes a member, joined via `link` and active, with the system actor: `write`, and `joined` is true. Activity: `member.add`.

When `joined` is true the API calls `notifier.memberJoinedByLink` once.

A request is handled like this:

```ts
const user = authenticate(config, initData, new Date());          // InitDataError -> 401
const launch = decodeLaunch(xLaunchHeader, config.linkSecret);    // LaunchError -> 401
const access = resolveAccess(db, user, launch);
if (access.level === 'none') return forbidden();                  // 403
const scope = memberScope(launch.groupId, access.member.id);
```

The bot builds its scope from the chat:

```ts
const group = findGroupByChatId(db, chatId);
const { member } = upsertTelegramMember(db, systemScope(group.id), profile);
const scope = memberScope(group.id, member.id);
```

### Membership discovery

`listGroupsForTelegramUser(db: Db, telegramUserId: number): Array<{ group: Group; member: Member }>`
returns only that Telegram user's existing, unmerged memberships, including inactive members.
It orders groups by latest activity timestamp descending, then activity ID and group ID descending
for ties. Invalid IDs and people with no memberships return `[]`. It writes no rows or activity.
Callers must authenticate the Telegram identity before using this operation to issue group links.

`GET /api/my-groups` needs `Authorization: tma <initData>` alone. It returns
`{ botUsername, groups: [{ id, title, tripName, balance: { amount, currency }, draftsCount, launch }] }`.
`tripName` and `balance` are null without an active trip; `draftsCount` is then zero.
Amounts are signed home-currency minor units, serialized as numbers. Launch parameters use the
current link version and destination `home`. No request group ID is used and no membership is created.

## Chat agent Phase A: migration 002 and `src/agent/index.ts`

Migration `002_agent.sql` adds only `agent_proposal`, `agent_turn` and `agent_usage`.
Existing tables and operations are unchanged by Phase A. These tables never write activity.
Proposals have random UUIDs, validated action plans and code-built summaries, JSON versions,
owner/group/chat IDs, an optional message ID, a 15-minute expiry, and pending/done/cancelled/expired status.
Usage rows reserve messages atomically in an immediate transaction, using Singapore days.

New exports from `src/db/index.js`:

```ts
createProposal(db: Db, scope: Scope, input: {
  chatId: number; messageId?: number; actions: unknown[]; summary: string;
  versions: unknown; now: Date;
}): AgentProposal
getProposal(db: Db, id: string): AgentProposal | undefined
finishProposal(db: Db, scope: Scope, id: string,
  status: 'done' | 'cancelled' | 'expired'): boolean
appendTurn(db: Db, scope: Scope, chatId: number,
  role: 'user' | 'assistant', content: string, now: Date): void
recentTurns(db: Db, scope: Scope, chatId: number, now: Date): AgentTurn[]
forgetExpiredTurns(db: Db, now: Date): number
reserveAgentMessage(db: Db, groupId: number, cap: number,
  now: Date, globalCap?: number): boolean
rememberChosenGroup(db: Db, scope: Scope, chatId: number, now: Date): void
chosenGroup(db: Db, telegramUserId: number, chatId: number):
  { groupId: number; memberId: number } | undefined
```

`getProposal` is a trusted callback lookup. Check the authenticated member before exposing its contents;
use `confirmProposal`/`cancelProposal` to apply those checks. `createProposal` accepts already validated
plans from the agent service; it is not a model-facing tool. It cancels earlier pending offers for the
same person/chat, including that Telegram person's memberships in other groups. `finishProposal` is
a scoped compare-and-set from pending and returns whether it changed a row.

A turn is an individual user or assistant message. Retention is at most eight messages per person/chat,
including across private-chat group switches; history returned to the model is additionally isolated
by group membership. The entire conversation expires after 30 minutes idle. Reads and appends purge
expired conversations; Phase B should also schedule `forgetExpiredTurns` to purge during idle periods.
Private choices use the reserved `agent_turn.role = 'chosen_group'` and empty content so the migration
still has three tables. Choices are not conversation turns, are not sent to the model, and do not expire.
`chosenGroup` accepts an authenticated Telegram identity and rechecks its unmerged membership.

New config fields are `agentEnabled`, `agentModel`, `agentDailyCap`, `agentGlobalDailyCap`.
Their environment variables are `AGENT_ENABLED` (strict true/false, blank follows presence of the API key),
`AGENT_MODEL` (gpt-6-luna), `AGENT_DAILY_CAP` (100), `AGENT_GLOBAL_DAILY_CAP` (1000).
A per-group cap of zero refuses every message; a global cap of zero disables that limit.

The Phase B entry point is `src/agent/index.js`; its file header documents the integration contract:

```ts
interface AgentModel {
  respond(input: AgentModelInput): Promise<AgentModelOutput>;
}
interface AgentDeps { model: AgentModel; suggestRate: RateSuggester }
runAgentTurn(db: Db, config: Config, deps: AgentDeps, input: {
  groupId: number; memberId: number; chatId: number; text: string; now: Date;
}): Promise<AgentTurnResult>
confirmProposal(db: Db, deps: ConfirmationDeps, input: ProposalDecision): ConfirmationResult
cancelProposal(db: Db, deps: ConfirmationDeps, input: ProposalDecision): ConfirmationResult
// applyProposal is an alias of confirmProposal. ConfirmationDeps is currently {}.
// ProposalDecision = { proposalId: string; memberId: number; now: Date }
```

`AgentModelInput` contains `instruction`, `conversation`, `trip` (an `untrusted_data` envelope),
`tools` (JSON schemas), `message`, ordered `steps` of calls/results, and `remainingToolCalls`.
Outputs are `{ kind: 'text', text }` or `{ kind: 'tool_calls', calls: [{ id, name, arguments }] }`.
There is no OpenAI implementation. Tests use `test/agent/fakeModel.ts`.
`AgentTurnResult` is reply/text, proposal/proposalId/summary/confirmLabel, limit, or unavailable.
Each message reserves usage once, including failures, and executes at most six tool calls.
All tool results, errors, names and receipt descriptions are wrapped as untrusted data.

`ConfirmationResult` is done/notices, not_yours/text, expired/text, changed/text,
already_done/text, or refused/reason. The transaction applies all actions, their foundation activity,
and the done status together. Only the first successful confirmation returns `AgentNotice[]`.
Each notice has a `method` naming a `Notifier` method and its correctly typed `payload`.
Phase B sends these after commit, to the group's current Telegram chat. Cancellation returns no notices.
This is an at-most-once handoff, not a durable notification outbox; transport failures or process crashes
must not cause a second application. Render summaries as plain text (or escape for the chosen parse mode).

All 23 PRD tools are exported through `registry`, `toolDefinitions`, and
`runTool(context: ToolContext, name: string, args: unknown): Promise<ToolOutcome>`.
Reading tools return data; changing tools return in-memory validated plans without changing any table.
`createAgentProposal` combines those plans and persists one offer. `proposalVersions` captures expense
and settlement versions plus a conservative group activity revision; *any* intervening activity in that
group invalidates an offer, including a member rename or a changed default everyone split.
Activity in another group does not invalidate it. Partial edits preserve loaded expense fields and items.
Receipt drafts may be edited but only `approve_draft` confirms them; `add_expense` always confirms.
Suggested rates are explicit proposed actions with origin suggested; null/invalid/failed suggestions ask
for a rate. Equivalent rate actions are deduplicated and applied before expense actions; summaries are
recomputed against those rates. Conflicting rates and multiple separate mutations of the same expense
or settlement are refused; combine field changes into one edit tool call. Other actions retain their order.
All arithmetic comes from foundation functions.

`test/agent/live/**` is excluded from normal Vitest runs. Phase C should add a dedicated live config and
package script, e.g. `test:agent: vitest run --config vitest.agent.config.ts`, following receipt/fx live tests.
Phase A does not change package scripts, wire Telegram handlers, implement a real model, or add live tests.

`AgentModelInput.today` also supplies the Singapore calendar date (`YYYY-MM-DD`) from the caller's
`now`, so a provider can interpret relative dates without guessing the server timezone.

## Notification settings

Migration `005_notifications.sql` adds `notification_setting`. Only departures from defaults are stored:
all group notices default to on, all personal notices to off. Partial unique indexes give one row per group
or member, kind and type. Restoring a default removes its row.

`getGroupNotificationSettings(db, scope)` and `getMyNotificationSettings(db, scope)` return every effective
boolean. `setGroupNotification(db, scope, type, enabled)` accepts any unmerged member of that group;
`setMyNotification(db, scope, type, enabled)` changes only the scope actor's settings. Both refuse unknown
types and non-boolean values. Group changes append `group.notification` activity with `{ type, enabled }`
before and after, atomically; no-ops and personal settings append nothing. This new activity action is
written within the new operation and exposed by the API without changing the foundation's existing action union.

Group types: `expense_added`, `expense_changed`, `expense_removed`, `payment`, `exchange_rate`, `trip`,
`member_joined`. Personal types: `added_me`, `changed_mine`, `payments_me`, `exchange_rate`, `draft_waiting`.
Link resets always post. Group settings apply across all trips in the group.

`isGroupNoticeEnabled(db, groupId, type)` reads the group decision. `personalRecipients(db, groupId, type,
memberIds)` returns only opted-in members among those IDs, in that group, with a Telegram ID, active and
unmerged. Delivery additionally removes the actor. New expense notices concern included members; changed
expenses concern the old and new participants and payers; payments concern their two parties. Rate notices
compare foundation balances immediately before and after the rate update, before applying a new expense or
approving a draft. Draft notices concern all eligible group members other than their creator.

Existing notice fields remain. Expense payloads carry `personal` and, for edits, `beforePersonal` snapshots
with actor, payer, included member IDs, trip context and foundation balances. Payment and rate payloads carry
actor and trip IDs plus parties or affected member IDs. These additions are optional for older callers;
all production mutation paths populate them. Drafts use the separate personal delivery helper so there is
no new group notice or change to the Notifier method contract. Private Open buttons use signed launch URLs,
or a web_app URL carrying the same start parameter when a public app address is configured. Delivery is best
effort, without retries; failure logs contain fixed categories and numeric codes, never names or message text.

`GET /api/notifications` returns `{ group, personal, canMessageMe, botUsername }` for the authenticated launch
group. `canMessageMe` is null because private reachability history is not tracked reliably. PUT
`/api/notifications/group/:type` and `/api/notifications/personal/:type` take only `{ enabled: boolean }` and
return `{ enabled }`; unknown types return 400. A body cannot select a group or a different person.

The Mini App's Notifications screen saves each switch immediately, disables it while saving and rolls it
back on failure. `/start notify` in private chat explains where to enable personal notices and supplies an
Open button. Private rate notices use “and your balance changed” rather than introducing balance-delta
arithmetic outside the foundation.
