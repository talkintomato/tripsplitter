import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { buildConfig } from '../../src/config.js';
import * as d from '../../src/db/index.js';
import { createMcpApp } from '../../src/mcp/http.js';
import { callTool, toolList, type McpDeps } from '../../src/mcp/server.js';
import { runTool } from '../../src/tools/index.js';
import { fakeNotifier } from '../receipts/harness.js';
import { expenseArgs, fixture, now } from '../agent/helpers.js';

/** Sam (Telegram user 1) is in two groups, Holiday and Other. */
function setup(config: Partial<ReturnType<typeof buildConfig>> = {}) {
  const f = fixture();
  const notifier = fakeNotifier();
  const deps: McpDeps = { db: f.db, config: buildConfig({ mcpEnabled: true, ...config }), suggestRate: async () => null, notifier, now: () => now };
  const { token, connection } = d.createConnectionToken(f.db, { telegramUserId: 1, clientName: 'Claude', now });
  return { f, deps, token, connection, notifier };
}
const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

describe('tools over MCP', () => {
  it('offers every shared tool, with the group added, and says which change records', () => {
    const tools = toolList();
    expect(tools.map((t) => t.name)).toContain('list_groups');
    const add = tools.find((t) => t.name === 'add_expense')!;
    expect(add.description).toMatch(/^Add a confirmed expense/);
    expect(add.description).toMatch(/wait for them to agree/);
    expect(add.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect((add.inputSchema.properties as Record<string, unknown>).group).toBeDefined();
    expect(tools.find((t) => t.name === 'get_balances')!.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('lists the person\'s groups, and needs one of them when there are several', async () => {
    const { f, deps, connection } = setup();
    const groups = JSON.parse(textOf(await callTool(deps, connection, 'list_groups', {})));
    expect(groups.map((g: { group: number }) => g.group).sort()).toEqual([f.g.group.id, f.other.group.id].sort());

    const missing = await callTool(deps, connection, 'get_balances', {});
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/Say which group/);
    const elsewhere = await callTool(deps, connection, 'get_balances', { group: 999 });
    expect(textOf(elsewhere)).toMatch(/not one of the connected person's groups/);
  });

  it('gives the same answer as the chat agent for the same read', async () => {
    const { f, deps, connection } = setup();
    d.createExpense(f.db, f.scope, { tripId: f.trip.id, payerId: f.member.id, description: 'Taxi', expenseDate: '2026-09-28', total: 1200, splitType: 'even', shares: [{ memberId: f.member.id }, { memberId: f.alex.id }] });
    const overMcp = JSON.parse(textOf(await callTool(deps, connection, 'get_balances', { group: f.g.group.id })));
    const direct = await runTool(f.context, 'get_balances', {});
    expect(overMcp).toEqual(JSON.parse(JSON.stringify(direct.kind === 'read' ? direct.data : null)));
  });

  it('makes a change at once, as the connected person, and tells the group naming the client', async () => {
    const { f, deps, connection, notifier } = setup();
    const result = await callTool(deps, connection, 'add_expense', { ...expenseArgs, group: f.g.group.id });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('Done.\n\n➕ Add Taxi\n\nTotal: 12.00 SGD\nPaid by you\nDate: Mon 28 Sep\nSplit equally between 2\n\nEach pays\n• Sam: 6.00 SGD\n• Alex: 6.00 SGD');
    const [saved] = d.listExpenses(f.db, f.scope, f.trip.id);
    expect(saved).toMatchObject({ status: 'confirmed', total: 1200, createdBy: f.member.id });
    // Nothing is kept waiting for a confirmation.
    expect(d.listExpenses(f.db, f.scope, f.trip.id, { status: 'draft' })).toEqual([]);
    expect(d.listActivity(f.db, f.scope, { limit: 1 })[0]).toMatchObject({ action: 'expense.create', actor: { kind: 'member', memberId: f.member.id } });
    expect(notifier.expenseSaved).toHaveBeenCalledWith(expect.objectContaining({ actorName: 'Sam (through Claude)' }));
    // The other group is untouched.
    expect(d.listExpenses(f.db, d.memberScope(f.other.group.id, f.other.members[0]!.id), f.other.trip!.id)).toEqual([]);
  });

  it('says what is wrong with the arguments, and changes nothing', async () => {
    const { f, deps, connection } = setup();
    const bad = await callTool(deps, connection, 'add_expense', { ...expenseArgs, amount: 'lots', group: f.g.group.id });
    expect(bad.isError).toBe(true);
    expect(d.listExpenses(f.db, f.scope, f.trip.id)).toEqual([]);
    expect((await callTool(deps, connection, 'drop_tables', {})).isError).toBe(true);
  });

  it('stops at the daily limit of the connection', async () => {
    const { deps, connection } = setup({ mcpDailyCapPerConnection: 2 });
    await callTool(deps, connection, 'list_groups', {});
    await callTool(deps, connection, 'list_groups', {});
    const third = await callTool(deps, connection, 'list_groups', {});
    expect(third.isError).toBe(true);
    expect(textOf(third)).toMatch(/limit/);
  });
});

describe('the MCP server over HTTP', () => {
  function client(deps: McpDeps, token: string) {
    const app = createMcpApp(deps);
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: async (url, init) => app.request(String(url), init as RequestInit),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const c = new Client({ name: 'test', version: '1.0.0' });
    return { c, transport, app };
  }

  it('lists and calls tools for a connected client', async () => {
    const { f, deps, token } = setup();
    const { c, transport } = client(deps, token);
    await c.connect(transport);
    const { tools } = await c.listTools();
    expect(tools.length).toBeGreaterThan(20);
    const result = await c.callTool({ name: 'add_expense', arguments: { ...expenseArgs, group: f.g.group.id } });
    expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(/^Done\./);
    expect(d.listExpenses(f.db, f.scope, f.trip.id)).toHaveLength(1);
    await c.close();
  });

  it('refuses a client without a working token', async () => {
    const { f, deps, token, connection } = setup();
    const app = createMcpApp(deps);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    expect((await app.request('/mcp', { method: 'POST', body, headers })).status).toBe(401);
    expect((await app.request('/mcp', { method: 'POST', body, headers: { ...headers, Authorization: 'Bearer ts_mcp_nope' } })).status).toBe(401);
    d.revokeConnection(f.db, { connectionId: connection.id, telegramUserId: 1, now });
    expect((await app.request('/mcp', { method: 'POST', body, headers: { ...headers, Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('pairs a client through the endpoints and the bot operations', async () => {
    const { f, deps } = setup();
    const app = createMcpApp(deps);
    const started = await (await app.request('/mcp/pair', { method: 'POST', body: JSON.stringify({ clientName: 'Cursor' }), headers: { 'Content-Type': 'application/json' } })).json() as { link: string; code: string; pairingId: string; secret: string };
    expect(started.link).toMatch(/^https:\/\/t\.me\/.+\?start=mcp_[2-9A-Z]{8}$/);
    expect(started.code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    const poll = () => app.request(`/mcp/pair/${started.pairingId}/token`, { method: 'POST', body: JSON.stringify({ secret: started.secret }), headers: { 'Content-Type': 'application/json' } });
    expect((await poll()).status).toBe(202);
    // What the bot does when the person opens the link and taps Allow.
    const claimed = d.claimPairing(f.db, { code: started.link.split('mcp_')[1], telegramUserId: 1, now });
    expect(claimed.kind).toBe('claimed');
    d.decidePairing(f.db, { pairingId: started.pairingId, telegramUserId: 1, allow: true, now });
    const answer = await poll();
    expect(answer.status).toBe(200);
    const { token, mcpUrl } = await answer.json() as { token: string; mcpUrl: string };
    expect(mcpUrl).toBe('http://localhost/mcp');
    expect(d.connectionForToken(f.db, token, now)).toMatchObject({ clientName: 'Cursor', telegramUserId: 1 });
    expect((await poll()).status).toBe(410);
    // The page for people.
    const page = await app.request('/mcp/connect');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Connect an AI client');
  });
});

