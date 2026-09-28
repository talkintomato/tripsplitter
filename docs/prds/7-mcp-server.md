# PRD 7: MCP server and shared tools

Status: proposal, not approved. Depends on PRD 6 phase A.

## Goal

The app's abilities are exposed once, as tools, and used by every AI client: the Telegram chat agent, and outside clients such as Claude or ChatGPT through an MCP server. One implementation, one set of rules, one activity log.

## Shared tools

1. Move `src/agent/tools/`, `registry.ts` and `proposal.ts` to `src/tools/`. Nothing in them depends on Telegram or on a model.
2. The Telegram agent (`src/agent/`) and the MCP server (`src/mcp/`) both import `src/tools/` and call tools through one function, `runTool(context, name, args)`. Neither has tools of its own.
3. A tool runs with a `ToolContext` holding the foundation `Scope` of one member in one group. No tool accepts a group from its caller's arguments.

## Confirmation

Changes are confirmed everywhere, in two steps.

| Step | Call | Effect |
|---|---|---|
| 1 | A changing tool, for example `add_expense` | Validates, previews, and returns a proposal: an id, the summary text, and when it expires. Changes nothing. |
| 2 | `confirm_proposal` with the id | Applies the proposal as the connected person, in one transaction |

`cancel_proposal` discards one. A proposal can be confirmed only by the connection that created it, expires after 15 minutes, and is refused if the records changed meanwhile. The tool descriptions tell the client to show the summary to the person and ask before confirming.

## Signing in

A person connects a client by approving it inside Telegram. They never type a handle or a code.

1. The client starts sign-in. The server creates a pairing request: random, single use, valid for 5 minutes. It shows a link, `https://t.me/<bot>?start=mcp_<code>`, and the same link as a QR code.
2. The person opens the link. Telegram opens their private chat with the bot and sends the code to it. Telegram tells the bot who they are by user ID.
3. The bot replies: "Connect **Claude** to TripSplitter? It will be able to read and change expenses in the groups you choose, as you." with the person's groups as tick boxes, and **Allow** and **Deny**.
4. On Allow the server issues a token to the waiting client, tied to that Telegram user and the chosen groups.

Why not "enter your Telegram handle and we send a code":

- A bot cannot message a person who has not opened a chat with it, so the code often could not be delivered. Opening the link is what opens that chat.
- Handles are optional, can change, and can be typed by anyone. The user ID from Telegram is the reliable identity.

Rules:

- A pairing code works once. Five wrong or expired attempts from one Telegram user in an hour pause pairing for that user for an hour.
- A person added by name, with no Telegram account, cannot connect until they claim their name in the Mini App.
- Tokens are stored as hashes. A token is shown to the client once.
- A connection reaches only the groups chosen when it was approved. Adding a group means approving again.
- When a connection reaches several groups, every tool takes a `group` argument, which must be one of the connection's groups. `list_groups` returns them.
- Creating, using for the first time, and revoking a connection are written to the activity log of each group it reaches.
- Every change made through a connection is recorded as made by that person, with the client's name noted: "Sam, through Claude".

## Managing connections

| Where | What |
|---|---|
| Bot, private chat | `/connections` lists the person's connections with a Revoke button each |
| Mini App | A Connections screen under the "more" menu: client name, groups, created, last used, Revoke |

## Transport

| Transport | Use | Sign-in |
|---|---|---|
| Streamable HTTP at `/mcp`, served by the existing server | Remote clients | OAuth, as MCP clients expect. The server is its own small OAuth provider whose sign-in page is the Telegram step above: it shows the link and QR code, waits for Allow, then returns to the client. |
| stdio, `pnpm mcp` | A client on the owner's own machine, for development | A token created with a command, tied to a member and group |

## Limits

Calls count against the same daily limits as the chat agent, per group and overall, plus a limit per connection of 300 calls a day.

## Settings

| Setting | Meaning | Default |
|---|---|---|
| `MCP_ENABLED` | Turns the MCP server on | `false` |
| `MCP_DAILY_CAP_PER_CONNECTION` | Calls per connection per day | `300` |

## Database

A fourth migration adds:

| Table | Fields |
|---|---|
| `mcp_pairing` | code hash, client name, status, telegram_user_id once known, created_at, expires_at |
| `mcp_connection` | id, telegram_user_id, client name, token hash, created_at, last_used_at, revoked_at |
| `mcp_connection_group` | connection_id, group_id, member_id |

`agent_proposal` gains a column for the connection that created it.

## Dependency

`@modelcontextprotocol/sdk`.

## Receipts

After the above: a `read_receipt` tool that takes an image, runs the existing receipt reader, and creates a draft for a person to approve. It counts against the receipt limits.

## Build order

| Phase | Contents |
|---|---|
| 1 | Move the tools to `src/tools/`, add `confirm_proposal`, `cancel_proposal` and `list_groups`, and point the Telegram agent at them. No behaviour change. |
| 2 | The Telegram agent's handlers and real model (PRD 6 phases B and C) |
| 3 | Pairing through the bot, connections, tokens, `/connections` |
| 4 | The MCP server over stdio, then over HTTP with OAuth |
| 5 | The Connections screen in the Mini App |
| 6 | `read_receipt` |

## Tests

- The same tool call gives the same result through the agent and through MCP.
- A changing tool over MCP changes nothing until `confirm_proposal`.
- A token reaches only its groups. A `group` outside them is refused. A revoked or unknown token is refused.
- Pairing: approved, denied, expired, reused, and the attempt limit.
- A change through a connection is logged against the person, with the client's name.
- Limits per connection, per group and overall.

## Open decisions

1. One connection for chosen groups, as written, or always one group per connection.
2. OAuth for remote clients from the start, or stdio and tokens first.
3. Whether the MCP server is turned on for the live app, or kept for the owner's own use.
