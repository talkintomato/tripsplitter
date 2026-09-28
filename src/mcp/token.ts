// Makes a token for a client on the owner's own machine, acting as a Telegram user, without the bot:
//
//   pnpm mcp:token <telegramUserId> [client name]
//
// The token is printed once. Revoke it by sending /connections to the bot as that user.
import { loadConfig } from '../config.js';
import { createConnectionToken, openDatabase } from '../db/index.js';

const [id, ...name] = process.argv.slice(2);
const config = loadConfig();
const db = openDatabase(config.databasePath);
const { token, connection } = createConnectionToken(db, { telegramUserId: Number(id), clientName: name.join(' ') || 'Local client', now: new Date() });
console.log(`Connected ${connection.clientName} as Telegram user ${connection.telegramUserId}.\nMCP_TOKEN=${token}`);
db.close();
