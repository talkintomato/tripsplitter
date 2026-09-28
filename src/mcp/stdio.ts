// The MCP server over stdio, for an AI client on the owner's own machine:
//
//   MCP_TOKEN=ts_mcp_… pnpm mcp
//
// The token comes from the connect page or from `pnpm mcp:token <telegramUserId>`. Group chats are not told
// about changes made this way, because no bot runs here; the activity log still records them.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config.js';
import { createRateSuggester } from '../fx/index.js';
import { connectionForToken, openDatabase } from '../db/index.js';
import { createMcpServer } from './server.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
const connection = connectionForToken(db, process.env.MCP_TOKEN ?? '', new Date());
if (!connection) {
  console.error('Set MCP_TOKEN to a token from /mcp/connect or `pnpm mcp:token <telegramUserId>`.');
  process.exit(1);
}
const server = createMcpServer({ db, config, suggestRate: createRateSuggester(config) }, connection);
await server.connect(new StdioServerTransport());
