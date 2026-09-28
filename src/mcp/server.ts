// The MCP server: the app's shared tools (src/tools), offered to outside AI clients such as Claude.
// A client acts as the person who connected it, in every group that person is a member of. Changes are
// applied when the tool is called: the client is told to show the person what will change and ask first.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Notifier, RateSuggester } from '../core/index.js';
import {
  DomainError, listGroupsForTelegramUser, memberScope, now as clockNow, reserveMcpCall,
  type Db, type Group, type McpConnection, type Member,
} from '../db/index.js';
import { isAllowedChat } from '../bot/support.js';
import { applyPlans, proposalVersions, registry, runTool, type AgentNotice, toPlainText, proposalSummary } from '../tools/index.js';

export interface McpDeps {
  db: Db;
  config: Config;
  suggestRate: RateSuggester;
  /** Tells the group chat about changes, as the Mini App and the chat agent do. Left out: no notices. */
  notifier?: Notifier;
  now?: () => Date;
}

/** Tools that only read. Every other tool changes something and is applied at once. */
const READ_TOOLS = new Set(['get_trip', 'list_members', 'resolve_members', 'list_expenses', 'get_expense', 'get_balances', 'list_settlements', 'get_activity', 'preview_expense']);
export const isChangingTool = (name: string): boolean => !READ_TOOLS.has(name);

const CHANGE_NOTE = 'This changes the group\'s records as soon as it is called. Before calling it, tell the person exactly what will change and wait for them to agree.';
/** The chat agent's descriptions talk of proposing; over MCP the change is made. */
const MCP_WORDING: Record<string, string> = {
  add_expense: 'Add a confirmed expense. Drafts cannot be created.',
  edit_expense: 'Change some fields of an existing expense, keeping the others.',
  set_trip_rate: 'Change a trip rate for one currency. Expenses without their own rate follow it.',
};
const GROUP_NOTE = 'The group to act in, from list_groups. Needed when the person is in more than one group.';

type Membership = { group: Group; member: Member };


/** The groups a connection reaches: every group its person is a member of now. */
export function connectionGroups(deps: McpDeps, connection: McpConnection): Membership[] {
  return listGroupsForTelegramUser(deps.db, connection.telegramUserId).filter((m) => isAllowedChat(deps.config, deps.db, m.group.chatId));
}

/** A tool's input schema as MCP wants it, with the group added. */
function inputSchema(schema: z.ZodType): { type: 'object'; [key: string]: unknown } {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  const properties = { ...(json.properties as Record<string, unknown> | undefined), group: { type: 'integer', description: GROUP_NOTE } };
  return { ...json, type: 'object', properties };
}

export function toolList(): Array<{ name: string; description: string; inputSchema: { type: 'object'; [key: string]: unknown }; annotations: Record<string, boolean> }> {
  return [
    {
      name: 'list_groups',
      description: 'The TripSplitter groups the connected person is in, each with its active trip. Other tools take one of these as "group".',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    ...registry.map((tool) => {
      const changing = isChangingTool(tool.name);
      const description = changing ? `${MCP_WORDING[tool.name] ?? tool.description} ${CHANGE_NOTE}` : tool.description;
      return { name: tool.name, description, inputSchema: inputSchema(tool.schema), annotations: { readOnlyHint: !changing, destructiveHint: changing } };
    }),
  ];
}

const text = (value: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

/** Tells the chat, naming the client: "Sam (through Claude) added …". */
async function dispatch(notifier: Notifier | undefined, notice: AgentNotice, clientName: string): Promise<void> {
  if (!notifier) return;
  const payload = { ...notice.payload } as Record<string, unknown>;
  if (typeof payload.actorName === 'string') payload.actorName = `${payload.actorName} (through ${clientName})`;
  await (notifier[notice.method] as (p: unknown) => Promise<void>)(payload).catch(() => undefined);
}

/** Runs one tool call for a connection. Exported for tests and for the stdio and HTTP transports alike. */
export async function callTool(deps: McpDeps, connection: McpConnection, name: string, rawArgs: unknown): Promise<CallToolResult> {
  const at = (deps.now ?? clockNow)();
  if (!reserveMcpCall(deps.db, connection.id, deps.config.mcpDailyCapPerConnection, at)) {
    return text("Today's limit of calls for this connection is reached. Try again tomorrow, or use the app.", true);
  }
  const groups = connectionGroups(deps, connection);
  if (name === 'list_groups') {
    return text(JSON.stringify(groups.map(({ group, member }) => ({ group: group.id, title: group.title, you: member.displayName })), null, 2));
  }
  if (!registry.some((tool) => tool.name === name)) return text(`There is no tool called ${name}.`, true);
  const { group: groupArg, ...args } = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  if (groups.length === 0) return text('The connected person is not in any TripSplitter group yet. Add the bot to a Telegram group first.', true);
  let who: Membership | undefined;
  if (groupArg === undefined) {
    if (groups.length > 1) return text(`Say which group with "group". Call list_groups to see them: ${groups.map((g) => `${g.group.id} (${g.group.title})`).join(', ')}.`, true);
    who = groups[0];
  } else {
    who = groups.find((g) => g.group.id === groupArg);
    if (!who) return text('That group is not one of the connected person\'s groups. Call list_groups.', true);
  }
  const scope = memberScope(who!.group.id, who!.member.id);
  const context = { db: deps.db, scope, suggestRate: deps.suggestRate, now: at };
  try {
    const versions = proposalVersions(deps.db, scope);
    const outcome = await runTool(context, name, args);
    if (outcome.kind === 'read') return text(JSON.stringify(outcome.data, null, 2));
    const result = applyPlans(deps.db, scope, { plans: outcome.plans, versions });
    if (result.kind !== 'done') return text(result.kind === 'refused' ? result.reason : result.text, true);
    for (const notice of result.notices) await dispatch(deps.notifier, notice, connection.clientName);
    return text(`Done.\n\n${toPlainText(proposalSummary(outcome.plans))}`);
  } catch (error) {
    if (error instanceof z.ZodError) return text(`The arguments are not valid: ${error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`, true);
    if (error instanceof DomainError) return text(error.message, true);
    if (error instanceof Error && /not available|not valid|must|Ask|Choose|No |There /.test(error.message)) return text(error.message, true);
    console.error('An MCP tool call failed:', error instanceof Error ? error.name : 'unknown');
    return text('That could not be done. Try again.', true);
  }
}

/** An MCP server for one connection. A new one per HTTP request, or one for a stdio session. */
export function createMcpServer(deps: McpDeps, connection: McpConnection): Server {
  const server = new Server(
    { name: 'tripsplitter', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'TripSplitter splits trip expenses in a Telegram group. You act as the connected person. Start with list_groups. ' +
        'Give amounts as written on the receipt, such as "84.50" or "3000", with the currency code. The server works out every share, conversion and balance: never calculate them yourself. ' +
        'Tools that change records apply at once, so always tell the person what will change and get their agreement first.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(deps, connection, request.params.name, request.params.arguments ?? {}));
  return server;
}
