import { expect, it } from 'vitest';
import { fingerprint } from '../db/helpers.js';
import { ANA, CHAT, harness, messageUpdate } from './helpers.js';

it.each([undefined, 'https://trip.example'])('private start uses the public address %s without storing private data', async (url) => {
  const h = harness();
  try {
    h.config.webhookUrl = url;
    const before = fingerprint(h.db);
    await h.bot.handleUpdate(messageUpdate(ANA.id, ANA, {
      chat: { id: ANA.id, type: 'private', first_name: 'Ana' },
      text: '/start private-text-not-to-store', entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    }));
    expect(h.sent()).toHaveLength(1);
    const reply = h.sent()[0]!.payload;
    expect(reply.text).toContain('Send me a photo of a receipt');
    if (url) expect(reply.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Open Trip Split', web_app: { url } }]] });
    else {
      expect(reply.reply_markup).toBeUndefined();
      expect(reply.text).toContain("group's pinned message");
    }
    expect(fingerprint(h.db)).toBe(before);
    expect(h.errors).toEqual([]);
    await h.bot.handleUpdate(messageUpdate(ANA.id, ANA, { chat: { id: ANA.id, type: 'private', first_name: 'Ana' }, text: 'private ordinary text' }));
    expect(h.sent()).toHaveLength(1);
    expect(fingerprint(h.db)).toBe(before);
  } finally { h.db.close(); }
});

it('does not send a private web_app button for group start', async () => {
  const h = harness();
  try {
    h.config.webhookUrl = 'https://trip.example';
    await h.bot.handleUpdate(messageUpdate(CHAT, ANA, { text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] }));
    expect(JSON.stringify(h.sent())).not.toContain('web_app');
  } finally { h.db.close(); }
});
