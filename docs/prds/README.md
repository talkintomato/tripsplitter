# TripSplitter PRDs

Design: [../designs/tripsplitter.md](../designs/tripsplitter.md). Where a PRD and the design disagree, the PRD wins. The PRDs resolve the concerns recorded at the end of the design and the findings of an independent review of the PRDs on 2026-09-27.

| # | PRD | Depends on | Owns these paths |
|---|---|---|---|
| 0 | [Foundation](0-foundation.md) | none | `package.json`, all config files, `.env.example`, `src/config.ts`, `src/core/`, `src/db/`, `src/api/auth.ts`, `test/core/`, `test/db/`, `test/auth/`, the initial `web/` scaffold, `docs/foundation-api.md` |
| 1 | [Bot in the group](1-bot.md) | 0 | `src/bot/`, `test/bot/`, `docs/telegram-verification.md` |
| 2 | [Mini App core](2-miniapp-core.md) | 0 | `src/api/` (except `auth.ts`), `web/` after the scaffold, `test/api/`, `test/web/` |
| 3 | [Receipt reading](3-receipts.md) | 0 | `src/receipts/`, `test/receipts/` |
| 3b | [Rate lookup](3b-rates.md) | 0 | `src/fx/`, `test/fx/`, `docs/rates.md` |
| 4 | [By-item split](4-item-split.md) | 2, 3 | `web/src/split-items/`, plus edits to the expense form, API client, expense routes and their tests |
| 5 | [Currency and launch](5-currency-launch.md) | 1 to 4 | `src/main.ts`, `Dockerfile`, `docs/deploy.md`, plus edits anywhere outside `src/core/` and `src/db/` |

Build order: 0, then 1, 2, 3 and 3b in parallel, then 4, then 5.

## Rules for every build

- PRDs 1, 2, 3 and 3b run at the same time in one working tree. Each writes only inside the paths it owns. A change needed elsewhere is reported in the build's final summary and not made.
- PRDs 4 and 5 run alone, so they may edit the files named in their row.
- PRD 0 installs every dependency and defines every setting and script the later PRDs need. A later build that needs a new one reports it and does not add it.
- A change needed in `src/core/` or `src/db/` after PRD 0 is reported, never made by another build.
- TypeScript strict mode. Tests with Vitest. `pnpm test` and `pnpm typecheck` must pass at the end of each build.
- No secrets in the repository. Configuration comes from environment variables read in `src/config.ts`.
- No build commits to git. The owner reviews and commits.
- Examples in PRDs, tests and messages use supported currencies only.

## Shared decisions

1. **Permissions**: every member of a group can do every action. No roles.
2. **Anyone with the group's link can join.** Opening the link as a Telegram user makes that person a member with full access, whether or not they are in the Telegram chat. This is the owner's decision: people outside the chat can be part of a trip. The protections are the activity log, restore, and resetting the link.
3. **Resetting the link**: any member can reset the group's link. Links issued before the reset stop working, and the bot posts a fresh pinned message with the new link. People who already joined stay members.
4. **Bots are never members.** The bot needs to receive all group messages to learn who is in the chat, which means privacy mode off in BotFather, or the bot being a group administrator.
5. **Active and inactive members**: a member who leaves the Telegram chat is marked inactive, which only means they are left out of new splits by default. They keep full access through the link.
6. **Groups, members and trips**: a group is one Telegram chat. Members belong to the group. A group has many trips, at most one active.
7. **Every record is reached through the group.** No operation accepts a bare record ID. A record outside the caller's group behaves as not found.
8. **Activity log**: every change writes an activity entry in the same transaction, with before and after values. Entries cannot be changed or removed. Changes made by Telegram events or by the bot itself are recorded with the actor "system".
9. **Deletes are soft** and can be restored by any member from the Activity screen.
10. **Stale edits**: an expense with its items and shares is one versioned unit, as is a settlement. Every change to an existing one carries the version the member was looking at, and is refused when it is out of date.
11. **Money**: integers in minor units. Balances are always recomputed, never stored.
12. **Item amounts are line totals.** "Beer x2 16.00" has amount 16.00. Quantity is descriptive and never multiplied.
13. **Rates are fixed per trip**, quoted as units of foreign currency per 1 unit of home currency. An expense can carry its own rate. When a trip has no rate for a currency, the latest mid-market rate is looked up and becomes the trip's rate, so nobody has to enter one. An expense waits as a draft for a rate only if that lookup fails.
14. **Home currency** can be changed until the trip's first confirmed expense or settlement. From then it is locked permanently, even if that expense is later deleted.
15. **Receipt photos**: only the Telegram file ID is stored, never the image.
16. **Message text**: ordinary chat messages are never stored or logged. Text sent with a tagged receipt is stored as that expense's description.
17. **Links into the Mini App** use one format, defined in PRD 0, carrying the signed group and an optional destination.
18. **Day boundaries** for daily limits use Singapore time.

## Notes from the foundation build

The foundation is built and `docs/foundation-api.md` is the reference for it. Where it differs from PRD 0, the built code and that document win. Points every later build needs:

- Operations take `db` first, then `scope`: `createExpense(db, scope, input)`.
- The API calls `authenticate(config, initData, now)`, which handles `DEV_FAKE_USER`, and not `verifyInitData` directly.
- `resolveAccess` returns `{ level, member, group, joined }`. `joined` is true when this call created the member.
- Amounts in records and inputs are `number`. Results of `computeShares`, `computeBalances` and `suggestPayments` are `bigint`, which `JSON.stringify` cannot handle, so convert with `toSafeNumber` or `amountsToRecord` before putting them in a response.
- Server code uses `NodeNext`, so relative imports end in `.js`. Code under `web/` and `test/web/` does not use the ending.
- `web/` must not import `src/core/index.js`, because it pulls in `node:crypto`. Import single files such as `src/core/currencies.ts`.
- `saveExpense` replaces the whole expense. A field left out goes back to its default, except currency, rate override, receipt reference and the review flag. A form must send back everything it loaded.
- On an existing expense, status is checked before version: a draft already confirmed gives `ValidationError` with `invalid_status`, and an old version on a record still in the right status gives `StaleEditError`.
- A claim can also be refused with `claim_changes_amounts`, when merging would move a rounding leftover. It lists the expenses, like the overlap refusal.
- `setTripRate` is refused on an ended trip.
- Installed versions are recent majors: TypeScript 7, Vite 8, Vitest 5, React 19, React Router 7, Zod 4, grammY 1.46, Hono 4, better-sqlite3 13. Check the installed package's own types and docs instead of relying on memory of older versions.
- Telegram's initData signature check was written from prior knowledge and has not been checked against real data from Telegram.
