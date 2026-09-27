# PRD 1: Bot in the group

Depends on PRD 0. Owns `src/bot/`, `test/bot/` and `docs/telegram-verification.md`.

Read [README.md](README.md) and `docs/foundation-api.md` first. Use the operations and types from PRD 0 as they are. Anything missing is reported, not patched.

## Goal

The bot can be added to a Telegram group, learns who is in it, and posts notices. It does not read receipts (PRD 3) and has no screens (PRD 2).

## Entry point

`createBot(config, db)` returns `{ bot, isAllowedChat, notifier }`:

- `bot`: a grammY bot that has not been started. PRD 5 starts it.
- `isAllowedChat(chatId)`: the rule in step 1 below, for PRD 3 to reuse.
- `notifier`: implements `Notifier` from `src/core/contracts.ts`.

## Handling order

Every update from a group passes through these steps, in order, before any other handler:

1. **Allowed chat**: when `ALLOWED_CHAT_IDS` is empty, which is the default, every chat is allowed and this step passes. Otherwise look the chat up with `findGroupByChatId`, which also matches earlier IDs of an upgraded group. The chat is allowed when its current ID or any earlier ID is in `ALLOWED_CHAT_IDS`. Export this as `isAllowedChat(config, db, chatId)` so PRD 3 uses the same rule. A chat that is not allowed stops here.
2. **Group exists**: call `ensureGroup`, which does nothing if the group is already set up. This covers a chat that was enabled after the bot was added, a restart, and the bot being removed and added again.
3. **Learn the sender**, as described below.
4. **Continue**: call `await next()` so that handlers registered later, including the receipt handlers, receive the update.

## Behaviour

### Chat not allowed

This applies only when `ALLOWED_CHAT_IDS` lists chat IDs. When the bot is added to a chat that is not allowed, or is mentioned in one, it posts "This group isn't enabled. Chat ID: `<id>`", at most once per hour per chat, and does nothing else there. The owner adds the ID to `ALLOWED_CHAT_IDS` and restarts. The next message in the group then sets it up.

### First set-up of a group

`ensureGroup` is given the chat title and the human administrators from `getChatAdministrators`. Then:

- Post the intro message, pin it if the bot has permission, and save its ID with `setIntroMessage`. If the group already has an intro message ID, no new one is posted.

### Intro message

```
Hi, I track shared expenses for this group.

To add a receipt: post the photo with @<bot> in the caption, or reply to a photo with @<bot>.
To add anything else: tap Add expense.

I notice who posts here so I know who is in the group. I don't store your messages, apart from any text you send with a tagged receipt, which becomes its description.
I only look at photos tagged with my name. Tagged photos are sent to an AI service to be read, and I keep a reference to the photo, not the photo.

[ Add expense ]  [ Balances ]
```

Buttons are URL buttons built with `launchUrl`, using views `add` and `balances`. `web_app` buttons are not used, because they do not work in groups.

### Learning members

- Every message from a human in an allowed group adds or updates that member (display name, username) and marks them active.
- `new_chat_members` adds members. `left_chat_member` marks a member inactive.
- A member who joined by link and later posts in the chat is the same member, matched by Telegram user ID.
- **Bots are never added**, on any path: message senders, administrators at set-up, the person who added the bot, join events and membership checks. Anonymous admin posts are skipped.
- These changes are recorded with the system actor.
- Ordinary message text is never stored or logged.

### Group upgraded to supergroup

On `migrate_to_chat_id`, call `migrateChat`. Post the new ID so the owner can update `ALLOWED_CHAT_IDS`. The group stays allowed in the meantime, across restarts, because earlier IDs are matched.

### Notices

Each `Notifier` function posts one line to the group. Amounts are formatted with `formatAmount`.

| Function | Example |
|---|---|
| `expenseSaved` | "Ana added Casa Pepe, 84.50 SGD, split by item. Sam 31.20 · Leo 22.80 · Ana 30.50" with a View button |
| `expenseEdited` | "Sam edited Casa Pepe: total 84.50 to 88.50 SGD" with a View button |
| `expenseDeleted`, `expenseRestored` | "Leo deleted Casa Pepe (84.50 SGD)" |
| `settlementRecorded`, `settlementUndone`, `settlementRestored` | "Sam paid Ana 31.20 SGD, recorded by Leo" |
| `tripRateChanged` | "Ana changed the trip rate: 1 SGD = 110 JPY. 7 expenses updated." When the origin is `suggested`: "Trip rate for JPY set to 1 SGD = 112.4 JPY. Change it in trip settings." |
| `memberJoinedByLink` | "Priya joined the trip through the link." |
| `linkReset` | "Ana reset the group's link. Old links no longer work." Then a new intro message is posted with buttons built from the new link version, pinned, and saved with `setIntroMessage`. View buttons on older notices stop working. |
| `tripEnded`, `tripReopened` | "Ana ended the trip. Balances can still be settled." |

View buttons use `launchUrl` with view `expense` and the expense ID. A notice that fails to post is logged and never throws.

## Verify against the live platform

These are assumptions from prior knowledge. Check each against a real test group and record the result in `docs/telegram-verification.md`:

1. With privacy mode off, the bot receives every group message.
2. A mention in a photo caption reaches the bot.
3. A reply to a photo that mentions the bot includes the original photo in `reply_to_message`.
4. URL buttons with a `startapp` link open the Mini App from a group, and the parameter arrives as `start_param`.
5. The group to supergroup upgrade sends `migrate_to_chat_id`.

If no bot token is available to the build, write the file with each item marked "not verified" and say so in the final summary.

## Tests

Handlers are tested with fake updates, without network access:

- Allowed and not allowed chats, and the once-an-hour limit on the refusal.
- A chat enabled after the bot was added is set up on its next message.
- Set-up run twice posts one intro.
- Member learning, join and leave.
- Bots skipped on every path, including an administrator that is a bot.
- Migration, and the group still allowed after a restart with only the old ID configured.
- A handler registered after `createBot` receives a tagged photo.
- Link reset posts a new intro with the new link version.
- Notice text for each function, including a zero-decimal currency.
- A notice that fails to send does not throw.

## Done when

Tests and typecheck pass, and with a real token the bot can be added to an allowed test group, posts the intro, and records members as they post.
