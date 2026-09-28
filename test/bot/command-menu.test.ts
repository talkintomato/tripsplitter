import { expect, it, vi } from 'vitest';
import { registerBotCommands } from '../../src/main.js';
import { harness } from './helpers.js';

it('registers the two Telegram scopes with the private-only commands in private chats', async () => {
  const h = harness();
  try {
    await registerBotCommands(h.bot);
    const common = [
      { command: 'split', description: 'Add an expense split equally, e.g. /split 24 taxi' },
      { command: 'today', description: 'What was spent today' },
      { command: 'wrap', description: 'Trip recap and who owes whom' },
      { command: 'help', description: 'How to use TripSplitter' },
    ];
    expect(h.sent('setMyCommands').map(c => c.payload)).toEqual([
      { commands: common, scope: { type: 'all_group_chats' } },
      { commands: [...common, { command: 'group', description: 'Choose a group' }, { command: 'connections', description: 'Manage connected AI clients' }], scope: { type: 'all_private_chats' } },
    ]);
  } finally { h.db.close(); }
});

it('logs failures without throwing and attempts both scopes', async () => {
  const h = harness();
  try {
    h.failing.add('setMyCommands');
    const logger = { error: vi.fn() };
    await expect(registerBotCommands(h.bot, logger)).resolves.toBeUndefined();
    expect(h.sent('setMyCommands')).toHaveLength(2);
    expect(logger.error.mock.calls).toEqual([
      ['Could not register Telegram commands for all_group_chats.'],
      ['Could not register Telegram commands for all_private_chats.'],
    ]);
  } finally { h.db.close(); }
});
