# Connecting an AI client (MCP)

TripSplitter offers its tools to AI apps such as Claude through an MCP server. A connected app acts as the person
who connected it, in all their groups, with the same rules as the Mini App and the chat bot.

## Turning it on

Set `MCP_ENABLED=true`. `MCP_DAILY_CAP_PER_CONNECTION` (default 300) limits tool calls per connection per day.

## Connecting, for a person

1. Open `https://<your server>/mcp/connect`, give the app a name, and tap **Get a link**.
2. Open the link on your phone (or send `/connect K7QF-2M9D` to the bot in a private chat) and tap **Allow**.
3. The page shows the server URL and a header, `Authorization: Bearer ts_mcp_…`. Add them to your AI app as a
   remote MCP server. The token is shown once.

Send `/connections` to the bot to see your connected apps and revoke one.

## On your own machine

```
pnpm mcp:token <your Telegram user ID> "Claude Desktop"
MCP_TOKEN=ts_mcp_… pnpm mcp
```

`pnpm mcp` speaks MCP over stdio. Group chats are not told about changes made this way, because no bot runs there.

## Rules

- Tools that only read run straight away. Tools that change records are applied when called: the app is told to
  show you what will change and ask first.
- Codes are single use, expire after 5 minutes, and work only in a private chat with the bot. Five wrong codes in
  an hour pause pairing for an hour.
- Codes and tokens are stored only as hashes. A revoked token stops working at once.
- Anyone who gets you to tap Allow on their link gets access as you. Only tap Allow for a link you started yourself.
