# PRD 6: Chat agent

Depends on everything before it. Owns `src/agent/`, `test/agent/`, and the parts of `src/bot/`, `src/db/`, `src/config.ts` and `src/main.ts` named below.

Read [README.md](README.md) and `docs/foundation-api.md` first. Money arithmetic, rates, access and the activity log come from the foundation and are not reimplemented here.

## Goal

A person can write to the bot in plain language and have it do what the Mini App can do: add and change expenses, record payments, answer questions about balances, and manage the trip. Every ability is a tool the agent calls. The agent never touches the database except through those tools.

```
Sam:  @trip_splitting_bot taxi from the airport 64 dollars, I paid, split between everyone
Bot:  Add this?
      Airport taxi · 64.00 SGD
      Paid by Sam · split equally between 5 people (12.80 each)
      [ Add it ]  [ Change ]  [ Cancel ]
Sam:  taps Add it
Bot:  Sam added Airport taxi, 64.00 SGD, split equally. ...
```

## Principles

1. **Tools are the only way to act.** Each tool wraps one foundation operation or a small, fixed combination. The model chooses tools and fills in arguments. It does no arithmetic and writes no SQL.
2. **Reading is free, changing needs a yes.** Tools that only read run straight away. Tools that change anything produce a proposal that the person who asked must confirm with a button. This is the same idea as receipt drafts: what the AI prepares, a person approves.
3. **The agent acts as the person who asked.** Every tool runs with a scope built from that person's member in that group, so the activity log shows who asked, and nothing outside the group can be reached.
4. **Only messages addressed to the bot are read by the agent.** Other chat messages are never sent to the model.
5. **Short replies.** One or two lines. Amounts formatted by the foundation. No markdown tables.

## When the agent runs

| Where | Trigger |
|---|---|
| Group chat | A text message that mentions `@<BOT_USERNAME>`, or a reply to one of the bot's own messages |
| Private chat with the bot | Any text message other than a command |

- A photo tagged with the bot's name is still handled by receipt reading (PRD 3), not by the agent. Text sent with the photo stays its description.
- In a private chat the agent needs to know which group is meant. One group: use it. Several: ask, with one button per group, and remember the choice for that private chat until the person changes it. None: say how to add the bot to a group.
- Messages from bots are ignored.
- `/start`, `/help` and any other command are handled as today and never reach the model. `/help` lists three example sentences.

## Tools

Names are stable and part of the contract. Arguments are validated with zod before anything runs. Amounts are passed as decimal strings in major units with a currency code, and converted with `toMinorUnits`. People are passed as names and resolved by `resolve_members`.

### Reading

| Tool | Returns |
|---|---|
| `get_trip` | Trip name, status, home currency, trip rates, member names |
| `list_members` | Members with whether each is active, hand-added, or joined by link |
| `list_expenses` | Expenses, filtered by status, date range, payer, text. Newest first, 20 at most. |
| `get_expense` | One expense with items, shares and each person's amount |
| `get_balances` | Each member's balance and the suggested payments |
| `list_settlements` | Recorded payments |
| `get_activity` | Recent activity, optionally for one expense |
| `resolve_members` | Matches names in the message to members. Returns exact matches, or the candidates when a name is ambiguous or unknown. "me" and "I" are the person asking. "everyone" is every active member. |
| `preview_expense` | What each person would pay for an expense described by the arguments, using the foundation's validation and split. Changes nothing. |

### Changing

| Tool | Does | Foundation operation |
|---|---|---|
| `add_expense` | Adds a confirmed expense: description, amount, currency, payer, date, split type, who is included, portions or items | `createExpense` |
| `edit_expense` | Changes fields of an existing expense | `saveExpense` with its version |
| `approve_draft` | Approves a receipt draft, optionally with changes | `saveExpense` with confirm |
| `discard_draft` | Discards a receipt draft | `discardExpense` |
| `delete_expense` | Deletes a confirmed expense | `deleteExpense` |
| `restore_expense` | Restores a deleted or discarded one | `restoreExpense` |
| `record_payment` | Records that one member paid another | `createSettlement` |
| `undo_payment` | Undoes a recorded payment | `undoSettlement` |
| `add_member` | Adds a person by name | `addManualMember` |
| `set_trip_rate` | Sets or changes the trip's rate for a currency | `previewTripRate` then `setTripRate` |
| `set_expense_rate` | Gives one expense its own rate, or clears it | `saveExpense` with `rateOverride` |
| `rename_trip` | Renames the trip | `renameTrip` |
| `end_trip` | Ends the trip | `endTrip` |
| `reopen_trip` | Reopens an ended trip | `reopenTrip` |

Not available to the agent: resetting the group's link, changing the home currency, claiming or merging members. These stay in the Mini App.

Several changes asked for in one message become one proposal listing each change, confirmed together and applied in one transaction. If any part is refused, none is applied.

## Proposals and confirmation

A changing tool does not change anything when the model calls it. It validates the arguments, runs the foundation's preview where there is one, and stores a proposal.

| Field | Meaning |
|---|---|
| id | Random, not guessable |
| group, member | Who asked, and where |
| actions | The validated tool calls, in order |
| summary | The text shown to the person, built by code from the validated arguments and the preview, never written by the model |
| versions | The version of every record the actions touch, as seen when the proposal was made |
| expires at | 15 minutes after creation |
| status | `pending`, `done`, `cancelled`, `expired` |

The bot posts the summary with three buttons.

| Button | Effect |
|---|---|
| **Add it** (or Change it, Delete it, and so on, by action) | Applies the actions as the person who asked, in one transaction, then posts the usual notice |
| **Change** | Asks what to change. The reply continues the same conversation and replaces the proposal. |
| **Cancel** | Marks it cancelled |

Rules:

- Only the person who asked can confirm or cancel. Anyone else tapping gets "Only Sam can confirm this."
- A proposal whose records changed since it was made is refused with "This changed since I prepared it. Ask me again."
- An expired proposal answers "That offer expired. Ask me again."
- A second tap on a finished proposal answers "Already done."
- The summary states every consequence that matters: the amount in both currencies when converted, the rate used and its source, who pays what, and for a trip rate change how many expenses will change.
- Deleting, ending a trip and changing a trip rate use the word for the action on the button and a warning line in the summary.

## Conversation

- The model sees: a fixed instruction, the trip's facts from `get_trip`, the last turns of this conversation, and the new message.
- A conversation is per person per chat. It holds at most the last 8 turns and is forgotten 30 minutes after its last message.
- Conversation text is stored only for that purpose, in its own table, and deleted when it expires. It is never written to the activity log or the application log.
- The instruction tells the model: use tools for every fact and every change; never state an amount it did not get from a tool; ask one short question when something needed is missing or a name is ambiguous; never invent a member; reply in the language the person wrote in; refuse anything unrelated to the trip's expenses in one line.
- At most 6 tool calls per message. After that the agent replies with what it has.
- When the model is unavailable, the bot replies "I can't do that right now. You can use the app instead." with a button to open the Mini App.

## Text from people and receipts is data

Descriptions, member names, merchant names and anything else that came from a person or a receipt are passed to the model as data, marked as such, and never as instructions. No tool can reach another group, the bot token, configuration or the file system. The worst a crafted message can do is produce a proposal, which a person then has to confirm.

## Privacy

The intro message gains one line: "If you write to me, I send your message to an AI service to understand it." Only messages addressed to the bot are sent. Requests ask the provider not to store them, as receipt reading does.

## Limits and cost

| Setting | Meaning | Default |
|---|---|---|
| `AGENT_ENABLED` | Turns the agent on | `true` when `OPENAI_API_KEY` is set |
| `AGENT_MODEL` | Model for the agent | `gpt-6-luna` |
| `AGENT_DAILY_CAP` | Messages handled per group per day | `100` |
| `AGENT_GLOBAL_DAILY_CAP` | Messages handled per day across all groups, 0 for no limit | `1000` |

At a cap the bot replies "I've reached today's limit. You can use the app instead." Counting uses Singapore days and an atomic reservation, as receipt reads do.

## Database

A second migration adds three tables. Nothing existing changes.

| Table | Fields |
|---|---|
| `agent_proposal` | id, group_id, member_id, chat_id, message_id, actions (JSON), summary, versions (JSON), status, created_at, expires_at |
| `agent_turn` | id, group_id, member_id, chat_id, role, content, created_at |
| `agent_usage` | id, group_id, day, created_at |

Operations: `createProposal`, `getProposal`, `finishProposal`, `appendTurn`, `recentTurns`, `forgetExpiredTurns`, `reserveAgentMessage`, and for private chats `rememberChosenGroup` and `chosenGroup`.

## Structure

```
src/agent/
  tools/          one file per tool: schema, run or propose, summary text
  registry.ts     the list of tools given to the model
  proposal.ts     building, summarising and applying proposals
  model.ts        AgentModel interface, and the OpenAI implementation
  loop.ts         message in, tool calls, reply or proposal out
  handlers.ts     registerAgentHandlers(bot, config, db, deps)
  prompt.ts       the fixed instruction
```

- `AgentModel` is an interface, so tests run the loop against a scripted fake.
- The OpenAI implementation uses the Responses API with function tools, no provider-side storage, no SDK retries.
- `registerAgentHandlers` is wired in `src/main.ts` after the receipt handlers.

## Tests

With a scripted fake model and a real in-memory database:

- Each reading tool returns what the foundation returns, scoped to the group.
- Each changing tool produces a proposal and changes nothing until confirmed (compare a fingerprint of the tables).
- Confirming applies the change as the person who asked, writes the activity entries and sends the notice once.
- Confirm by someone else, after expiry, twice, and after the record changed.
- Several actions in one proposal apply together or not at all.
- Names: exact, ambiguous, unknown, "me", "everyone".
- A foreign currency with a trip rate, with a suggestion, and with no rate.
- Text containing instructions in a description or a member name does not change which tools are allowed or the scope.
- A tool call with an expense from another group is refused.
- The tool call limit, the daily caps, and the model being unavailable.
- Conversation: turns are kept per person per chat, capped at 8, and forgotten after 30 minutes.
- Triggers: a mention, a reply to the bot, a private message, a command, a tagged photo, a message from a bot, a message that does not mention the bot.
- Private chat with no group, one group and several groups.
- The summary text for every changing tool, including a zero-decimal currency.

One live test under `test/agent/live/`, not part of `pnpm test`, that sends five sentences to the real model and checks which tools it calls.

## Build order

| Phase | Contents |
|---|---|
| A | Migration and operations, tools, registry, proposals, the loop with a fake model, tests |
| B | The OpenAI model, handlers for group and private chats, buttons, wiring in `src/main.ts`, limits, the intro line |
| C | The live test, `/help`, documentation in `docs/agent.md` |

## Done when

Tests and typecheck pass, and in a real group a person can add an expense, ask who owes what, and record a payment by writing to the bot.
