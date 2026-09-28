# Chat agent

Write to the bot in a group by mentioning its username or replying to one of its messages. In private chat, send any text. Commands do not go to the model. Receipt photos and image files go to the separate receipt reader: send any photo privately, or mention the bot in the caption (or a reply to the image) in a group. Messages from bots and ordinary group conversation do not go to the chat agent.

Every change needs confirmation from the person who asked. The proposal shows the validated amount, split, rates and consequences. Add it (or the appropriate action button) applies it. Change asks “What should I change?”; reply to that prompt to continue the conversation and prepare a replacement. The old offer is cancelled immediately. Cancel discards the offer. Offers expire after 15 minutes. An intervening change in the group makes an offer stale, so ask again. Nobody else can confirm, change or cancel your offer.

The agent can read trip details, members, expenses, balances, payments and activity; preview splits; add/edit/delete/restore expenses; approve/discard receipt drafts; record/undo payments; add people; set rates; rename, end and reopen trips. Several requested changes are reviewed together and committed in one transaction. It cannot reset the group's link, change home currency, claim or merge people, access another group, read secrets or files, or act on unrelated requests. Use the Mini App for capabilities outside this list.

In private chat, one eligible group is selected automatically. With several groups, select a button; the original question then runs in that group. The choice is remembered. Use /group to switch. With no group, add the bot to a group and write there first. Only existing memberships in allowed groups are offered. Confirmed changes made privately still send their normal notices to the group. The private reply confirms completion.

Send me a photo of a receipt: private receipts use the same remembered group and /group command as the agent. With several groups and no choice, the bot asks "Which trip is this receipt for?" before downloading or reserving a read. The pending file reference, caption-derived description and original message metadata are kept only in memory, one per person/private chat, for ten minutes; a new receipt replaces it, /group clears it, and restart loses it. No image bytes are retained there. The group choice still persists in the existing database. Eligible memberships follow the agent's rules (existing, non-merged memberships in allowed groups; inactive members remain eligible).

The private reply names the group and offers Split evenly and Open to split. With a public webhook URL the latter is a web_app button carrying the signed expense launch parameter; otherwise it uses the normal Telegram Mini App link. A new private receipt posts one short draft notice with an Open button in its group. Approval sends the normal saved-expense notice to that group. JPEG, PNG and WebP image documents work like photos; HEIC documents use Telegram's JPEG preview when available, otherwise the bot asks for a photo or JPEG. Preview resolution can reduce reading accuracy. The existing 20 MiB limit and receipt caps apply, and untagged group images are never downloaded.

/help shows three examples and an app button in either kind of chat.

## What goes to OpenAI

The chat agent sends the addressed message (with bot mentions stripped), a fixed instruction, the Singapore date, trip facts, the last eight stored user/assistant messages for that person's chat and group, the tool definitions, and results of tool calls in the current turn. Tool results can include expense descriptions, receipt-derived text, member profiles (including Telegram IDs and usernames), amounts, receipt file references and activity records. Text from people and receipts is marked as untrusted data. The agent sends no receipt images, Telegram token, app configuration or signed Mini App links. Receipt reading is a separate feature.

Requests use the Responses API with `store: false`, asking OpenAI not to store responses. This is not a claim about all provider retention policies. SDK retries and logging are disabled. Each step has a 60-second timeout and a 4,096 output-token cap. Encrypted reasoning and ordered output items are replayed in memory during the current turn; no provider conversation ID is used. Conversation text is never logged or written to activity, though confirmed expense/member/trip fields retain the text needed for those records. Proposal summaries/actions are also stored for confirmation and status checks.

Local conversation history holds at most eight messages per person/chat and expires after 30 minutes without a message. Expired conversations are physically deleted opportunistically when the agent handles further messages or callbacks, rather than on an idle timer. The selected private group is separate from history and persists. A pending private question waiting for group selection is held only in memory, expires after 30 minutes and is lost on restart.

## Settings and limits

- `AGENT_ENABLED`: defaults to true when `OPENAI_API_KEY` is set. Set `AGENT_ENABLED=false` and restart to turn chat off. Without a key it cannot call the model, even if explicitly enabled; mentions get an app button.
- `AGENT_MODEL`: defaults to `gpt-6-luna`.
- `AGENT_DAILY_CAP`: defaults to 100 addressed messages per group per Singapore day. Zero prevents turns.
- `AGENT_GLOBAL_DAILY_CAP`: defaults to 1,000 messages across groups per Singapore day. Zero removes only the global limit.

A message reserves usage before its first model call, including failures. Each message can make at most six tool calls. Limits and model failures produce a short reply and an app button. These settings are independent of receipt limits. Disabling the agent does not disable receipts or the Mini App.

Notices are handed off once after the database transaction commits. A failed Telegram edit does not prevent notice attempts. Delivery is not a durable outbox: transport failure or a process crash can lose a notice, and a second tap will not resend or reapply it.

## Ten examples

Replace `@your_bot` with your bot's username; omit it in private chat.

1. @your_bot taxi 24 SGD today, I paid, split evenly between everyone
2. @your_bot who owes what?
3. @your_bot show the recent expenses
4. @your_bot Alex paid me 12 SGD; record the payment
5. @your_bot add Lee to the trip
6. @your_bot rename this trip to Japan holiday
7. @your_bot change the taxi expense to 30 SGD
8. @your_bot delete the taxi expense
9. @your_bot set the trip rate to 1 SGD = 112 JPY
10. @your_bot end this trip

Names that could refer to more than one person and missing details cause a short follow-up question. “Me” is the person asking; “everyone” means active members.

## Owner's live check

Normal `pnpm test` never runs `test/agent/live/`. To opt in, add this scripts entry to package.json:

```json
"test:agent": "vitest run --config vitest.agent.config.ts"
```

Export `OPENAI_API_KEY` in the process environment and run `pnpm test:agent` (or `pnpm exec vitest run --config vitest.agent.config.ts` before adding the script). It does not load `.env`. Without a key, all five cases skip and exit successfully. With a key, it sends five synthetic sentences, reports tool names and counts, and checks the expected tools. It uses an in-memory database and never confirms a change or calls Telegram. Real model requests cost money and may fail if the configured model is unavailable to the key.

Offline tests cover the provider request/response protocol, strict schema encoding, errors, trigger routing, conversations, choices, limits and confirmations with fake transports. Real model interpretation, provider acceptance and Telegram delivery still require the owner's live check.
