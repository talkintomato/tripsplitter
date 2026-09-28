import { describe, expect, it } from 'vitest';
import * as d from '../../src/db/index.js';
import { MCP_TEXT } from '../../src/bot/mcp.js';
import { ANA, SAM, harness, NOW } from '../agent/harness.js';

const command = (text: string) => ({ entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] });

function setup() {
  const h = harness([], { config: { mcpEnabled: true } });
  const at = () => new Date();
  const start = () => d.startPairing(h.db, { clientName: 'Claude', now: at() });
  const privately = (text: string, from = ANA) => h.send(text, command(text), from, from.id);
  const last = () => h.sent().at(-1)!;
  return { ...h, start, privately, last, at };
}

describe('connecting an AI client through the bot', () => {
  it('asks the person who opened the link, and connects on Allow', async () => {
    const h = setup();
    const { pairing, code, secret } = h.start();
    await h.privately(`/start mcp_${code}`);
    expect(h.last().text).toMatch(/^Connect Claude to TripSplitter\?/);
    expect(h.last().text).toMatch(/in all your groups: Trip 0/);
    expect(h.last().text).toMatch(/Only tap Allow if you started this yourself/);
    expect(h.buttons().map((b) => b.text)).toEqual(['Allow', 'Deny']);
    // Someone else's tap does nothing.
    await h.tap(h.data('Allow'), SAM, SAM.id);
    expect(d.collectPairing(h.db, { pairingId: pairing.id, secret, now: h.at() }).kind).toBe('waiting');

    await h.tap(`mcp:allow:${pairing.id}`, ANA, ANA.id);
    expect(h.sent('editMessageText').at(-1)!.text).toMatch(/^Connected Claude\./);
    const collected = d.collectPairing(h.db, { pairingId: pairing.id, secret, now: h.at() });
    expect(collected).toMatchObject({ kind: 'token', connection: { telegramUserId: ANA.id } });
    // The token never went through Telegram.
    if (collected.kind === 'token') expect(JSON.stringify(h.api)).not.toContain(collected.token);
  });

  it('takes a typed code with /connect, and not in a group', async () => {
    const h = setup();
    const { code } = h.start();
    await h.send(`/connect ${code}`, command('/connect x'));
    expect(h.last().text).toBe(MCP_TEXT.privateOnly);
    await h.privately(`/connect ${code.slice(0, 4)}-${code.slice(4)}`);
    expect(h.last().text).toMatch(/^Connect Claude/);
    await h.privately('/connect');
    expect(h.last().text).toBe(MCP_TEXT.noCode);
    await h.privately('/connect ZZZZ-ZZZZ');
    expect(h.last().text).toBe(MCP_TEXT.unknown);
  });

  it('says Not connected on Deny, and lists and revokes connections', async () => {
    const h = setup();
    const { pairing, code } = h.start();
    await h.privately(`/start mcp_${code}`);
    await h.tap(`mcp:deny:${pairing.id}`, ANA, ANA.id);
    expect(h.sent('editMessageText').at(-1)!.text).toBe('Not connected.');

    await h.privately('/connections');
    expect(h.last().text).toBe('No AI clients are connected.');
    const { connection, token } = d.createConnectionToken(h.db, { telegramUserId: ANA.id, clientName: 'Cursor', now: NOW });
    await h.privately('/connections');
    expect(h.last().text).toMatch(/Cursor, connected 2026-09-28/);
    await h.tap(h.data('Revoke Cursor'), ANA, ANA.id);
    expect(d.connectionForToken(h.db, token, h.at())).toBeUndefined();
    expect(d.getConnection(h.db, connection.id)!.revokedAt).not.toBeNull();
  });

  it('leaves a plain /start alone', async () => {
    const h = setup();
    await h.privately('/start');
    expect(h.last().text).toMatch(/Trip Split/);
  });
});
