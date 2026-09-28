import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as d from '../../src/db/index.js';
import { AGENT_TEXT, proposalCallback } from '../../src/agent/handlers.js';
import { decodeLaunch } from '../../src/core/index.js';
import { harness, ANA, SAM, BOT_INFO, CHAT, BOT_USERNAME, NOW, args, type Harness } from './harness.js';
import { calls, text, type ScriptStep } from './fakeModel.js';
const opened: Harness[] = [];
const make = (script: ScriptStep[] = [text()], options: Parameters<typeof harness>[1] = {}) => { const h = harness(script, options); opened.push(h); return h; };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(NOW); });
afterEach(() => { opened.splice(0).forEach(h => h.db.close()); vi.useRealTimers(); });
const proposalScript = () => [calls(['add_expense', args]), text()];
const proposals = (h: Harness) => h.db.prepare('SELECT id FROM agent_proposal ORDER BY created_at, rowid').all() as { id: string }[];
const latest = (h: Harness) => d.getProposal(h.db, proposals(h).at(-1)!.id)!;
const alert = (h: Harness, value: string) => expect(h.sent('answerCallbackQuery').at(-1)).toMatchObject({ text: value, show_alert: true });

it.each(['mention', 'mixed-case', 'text_mention', 'reply', 'private'])('handles %s and replies to the question with typing', async kind => {
  const h = make();
  let id: number;
  if (kind === 'mention') id = await h.mention('hello');
  else if (kind === 'mixed-case') id = await h.send(`@${BOT_USERNAME.toUpperCase()} hello`, { entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }] });
  else if (kind === 'text_mention') id = await h.send('🤖 Bot hello', { entities: [{ type: 'text_mention', offset: 3, length: 3, user: BOT_INFO }] });
  else if (kind === 'reply') id = await h.send('hello', { reply_to_message: { message_id: 1, from: BOT_INFO } });
  else id = await h.privateText('hello');
  expect(h.model.requests).toHaveLength(1);
  expect(h.model.requests[0]!.message).toBe(kind === 'text_mention' ? '🤖  hello' : 'hello');
  expect(h.sent().at(-1)).toMatchObject({ text: 'Ready.', reply_parameters: { message_id: id } });
  expect(h.sent('sendChatAction')).toEqual([{ chat_id: kind === 'private' ? ANA.id : CHAT, action: 'typing' }]);
});
it.each(['plain', 'unmarked-name', 'other-mention', 'other-text-mention', 'reply-other-bot', 'command', 'private-command', 'bot', 'anonymous', 'edited', 'channel'])('passes on %s without a model call', async kind => {
  const h = make();
  if (kind === 'plain') await h.send('hello');
  if (kind === 'unmarked-name') await h.send(`@${BOT_USERNAME} hello`);
  if (kind === 'other-mention') await h.send('@other hi', { entities: [{ type: 'mention', offset: 0, length: 6 }] });
  if (kind === 'other-text-mention') await h.send('Ana hi', { entities: [{ type: 'text_mention', offset: 0, length: 3, user: ANA }] });
  if (kind === 'reply-other-bot') await h.send('hi', { reply_to_message: { from: { ...BOT_INFO, id: 777 } } });
  if (kind === 'command') await h.send(`/whatever@${BOT_USERNAME}`, { entities: [{ type: 'bot_command', offset: 0, length: 10 + BOT_USERNAME.length }] });
  if (kind === 'private-command') await h.privateText('/whatever');
  if (kind === 'bot') await h.mention('hi', {}, BOT_INFO);
  if (kind === 'anonymous') await h.mention('hi', { sender_chat: { id: CHAT, type: 'group', title: 'Trip 0' } });
  if (kind === 'edited') await h.bot.handleUpdate({ update_id: 99, edited_message: { message_id: 1, date: 1, edit_date: 2, from: ANA, chat: { id: ANA.id, type: 'private', first_name: 'Ana' }, text: 'hi' } });
  if (kind === 'channel') await h.send('hi', { chat: { id: CHAT, type: 'channel', title: 'Trip 0' } });
  expect(h.model.requests).toEqual([]);
  expect(h.passed).toHaveBeenCalledOnce();
  expect(h.db.prepare('SELECT * FROM agent_usage').all()).toEqual([]);
});
it.each([false, true])('tagged photo reaches receipts and never the agent (receiptAfter=%s)', async receiptAfter => {
  const h = make([], { receiptAfter });
  await h.send('', { text: undefined, caption: `@${BOT_USERNAME} lunch`, photo: [{ file_id: 'photo', file_unique_id: 'p', width: 10, height: 10 }] });
  expect(h.readReceipt).toHaveBeenCalledOnce();
  expect(h.model.requests).toHaveLength(0);
});
it('a tagged reply to a photo also reaches receipts', async () => {
  const h = make([], { receiptAfter: true });
  await h.mention('lunch', { reply_to_message: { photo: [{ file_id: 'photo', file_unique_id: 'p', width: 10, height: 10 }], from: SAM } });
  expect(h.readReceipt).toHaveBeenCalledOnce(); expect(h.model.requests).toEqual([]);
});
it('an untagged photo passes on', async () => {
  const h = make();
  await h.send('', { text: undefined, photo: [{ file_id: 'p', file_unique_id: 'p', width: 1, height: 1 }] });
  expect(h.readReceipt).not.toHaveBeenCalled(); expect(h.model.requests).toEqual([]); expect(h.passed).toHaveBeenCalledOnce();
});
it('keeps typing during a slow turn and stops when it finishes', async () => {
  let done!: (value: ReturnType<typeof text>) => void;
  const h = make([() => new Promise(resolve => { done = resolve; })]);
  const running = h.mention('hello');
  await vi.waitFor(() => expect(done).toBeTypeOf('function'));
  await vi.advanceTimersByTimeAsync(8000);
  expect(h.sent('sendChatAction')).toHaveLength(3);
  done(text()); await running;
  await vi.advanceTimersByTimeAsync(8000);
  expect(h.sent('sendChatAction')).toHaveLength(3);
});
it('posts a code-built proposal and three bounded callbacks; commits and notifies exactly once', async () => {
  const h = make(proposalScript());
  const id = await h.mention('taxi');
  expect(h.sent().at(-1)).toMatchObject({ text: expect.stringContaining('24.00 SGD'), parse_mode: 'HTML', reply_parameters: { message_id: id } });
  expect(h.buttons().map(b => b.text)).toEqual(['Approve', 'Change', 'Cancel']);
  for (const button of h.buttons()) expect(Buffer.byteLength(button.callback_data!)).toBeLessThanOrEqual(64);
  const p = latest(h), data = h.data('Approve');
  expect(d.listExpenses(h.db, d.systemScope(p.groupId), h.groups[0]!.trip!.id)).toEqual([]);
  await h.tap(data);
  expect(d.getProposal(h.db, p.id)!.status).toBe('done');
  expect(h.sent('editMessageText').at(-1)).toMatchObject({ text: '✅ Added Taxi · 24.00 SGD', parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'View', url: expect.any(String) }]] } });
  expect(h.notifier.expenseSaved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: CHAT, actorName: 'Ana', total: 2400 }));
  await h.tap(data);
  alert(h, 'Already done.'); expect(h.notifier.expenseSaved).toHaveBeenCalledOnce();
});
it.each(['yes', 'cancel', 'change'] as const)('only the asker may %s, including after completion', async action => {
  const h = make(proposalScript()); await h.mention('taxi');
  const p = latest(h);
  await h.tap(proposalCallback(action, p.id), SAM);
  alert(h, 'Only Ana can confirm this.'); expect(d.getProposal(h.db, p.id)!.status).toBe('pending');
  await h.tap(proposalCallback('yes', p.id));
  await h.tap(proposalCallback(action, p.id), SAM); alert(h, 'Only Ana can confirm this.');
});
it.each(['yes', 'cancel', 'change'] as const)('rejects expired and stale proposals for %s', async action => {
  const h = make([...proposalScript(), ...proposalScript()]);
  await h.mention('taxi'); const expired = latest(h);
  vi.setSystemTime(new Date(NOW.getTime() + 15 * 60_000));
  await h.tap(proposalCallback(action, expired.id)); alert(h, 'That offer expired. Ask me again.');
  expect(d.getProposal(h.db, expired.id)!.status).toBe('expired');
  await h.mention('taxi'); const stale = latest(h);
  d.renameTrip(h.db, d.memberScope(stale.groupId, stale.memberId), h.groups[0]!.trip!.id, 'Changed');
  await h.tap(proposalCallback(action, stale.id)); alert(h, 'This changed since I prepared it. Ask me again.');
  expect(h.notifier.expenseSaved).not.toHaveBeenCalled();
});
it('cancel removes buttons and a second tap refuses', async () => {
  const h = make(proposalScript()); await h.mention('taxi'); const p = latest(h);
  await h.tap(proposalCallback('cancel', p.id));
  expect(h.sent('editMessageText').at(-1)).toMatchObject({ text: 'Cancelled.', reply_markup: { inline_keyboard: [] } });
  expect(d.getProposal(h.db, p.id)!.status).toBe('cancelled');
  await h.tap(proposalCallback('yes', p.id)); alert(h, 'That offer was cancelled.');
  expect(h.notifier.expenseSaved).not.toHaveBeenCalled();
});
it('Change continues the same conversation and replaces the cancelled proposal', async () => {
  const h = make([...proposalScript(), calls(['add_expense', { ...args, amount: '30' }]), text()]);
  await h.mention('taxi'); const first = latest(h);
  await h.tap(proposalCallback('change', first.id));
  expect(h.sent().at(-1)).toMatchObject({ text: 'What should I change?', reply_markup: { force_reply: true, selective: true }, reply_parameters: { message_id: 998 } });
  expect(d.getProposal(h.db, first.id)!.status).toBe('cancelled');
  await h.send('make it 30', { reply_to_message: { from: BOT_INFO, message_id: 1 } });
  expect(h.model.requests[2]!.conversation.map(t => t.content).join('\n')).toContain('24.00 SGD');
  const second = latest(h); expect(second.id).not.toBe(first.id); expect(second.summary).toContain('30.00 SGD');
  await h.tap(proposalCallback('yes', first.id)); alert(h, 'That offer was cancelled.');
  await h.tap(proposalCallback('yes', second.id)); expect(h.notifier.expenseSaved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ total: 3000 }));
});
it('delivers every notice once even if the Telegram edit or an earlier notifier fails', async () => {
  const h = make([calls(['add_expense', args], ['record_payment', { from: 'Sam Tan', to: 'Ana', amount: '12', currency: 'SGD' }]), text()]);
  await h.mention('taxi and payment'); const data = h.data('Approve');
  h.failing.add('editMessageText'); h.failing.add('answerCallbackQuery');
  vi.mocked(h.notifier.expenseSaved).mockRejectedValueOnce(new Error('failed'));
  await h.tap(data);
  expect(h.notifier.expenseSaved).toHaveBeenCalledOnce(); expect(h.notifier.settlementRecorded).toHaveBeenCalledOnce();
  h.failing.clear(); await h.tap(data); alert(h, 'Already done.');
  expect(h.notifier.expenseSaved).toHaveBeenCalledOnce(); expect(h.notifier.settlementRecorded).toHaveBeenCalledOnce();
});
it('finishes an action without a notice with a meaningful final line', async () => {
  const h = make([calls(['rename_trip', { name: 'Japan' }]), text()]); await h.mention('rename');
  await h.tap(proposalCallback('yes', latest(h).id)); expect(h.sent('editMessageText').at(-1)?.text).toBe('✅ Renamed trip Japan');
});
it('private chat with no group gives onboarding without creating a group', async () => {
  const h = make([], { groups: 0 }); await h.privateText('taxi');
  expect(h.sent().at(-1)?.text).toBe(AGENT_TEXT.noGroup);
  expect(h.db.prepare('SELECT * FROM chat_group').all()).toEqual([]); expect(h.model.requests).toEqual([]);
});
it('private chat with one group remembers it and sends confirmed notices to the group', async () => {
  const h = make(proposalScript()); await h.privateText('taxi');
  expect(d.chosenGroup(h.db, ANA.id, ANA.id)?.groupId).toBe(h.groups[0]!.group.id);
  const p = latest(h); expect(p.chatId).toBe(ANA.id);
  await h.tap(proposalCallback('yes', p.id), ANA, ANA.id);
  expect(h.sent('editMessageText').at(-1)).toMatchObject({ chat_id: ANA.id, text: '✅ Added Taxi · 24.00 SGD', parse_mode: 'HTML' });
  expect(h.notifier.expenseSaved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: CHAT }));
});
it('several private groups: selects, handles the pending question once, remembers and switches with /group', async () => {
  const h = make([text(), text(), text()], { groups: 2 }); await h.privateText('Who owes what?');
  expect(h.model.requests).toEqual([]); expect(h.buttons().map(b => b.text).sort()).toEqual(['Trip 0', 'Trip 1']);
  await h.tap(`ag:g:${h.groups[0]!.group.id}`, ANA, ANA.id);
  expect(h.model.requests).toHaveLength(1); expect(h.model.requests[0]!.message).toBe('Who owes what?');
  await h.tap(`ag:g:${h.groups[0]!.group.id}`, ANA, ANA.id); expect(h.model.requests).toHaveLength(1);
  await h.privateText('Again'); expect(h.model.requests).toHaveLength(2);
  await h.send('/group', { entities: [{ type: 'bot_command', offset: 0, length: 6 }] }, ANA, ANA.id);
  expect(h.buttons()).toHaveLength(2); expect(h.model.requests).toHaveLength(2);
  await h.tap(`ag:g:${h.groups[1]!.group.id}`, ANA, ANA.id);
  await h.privateText('Other trip'); expect(h.model.requests).toHaveLength(3); expect(h.model.requests[2]!.conversation).toEqual([]);
  expect(d.chosenGroup(h.db, ANA.id, ANA.id)?.groupId).toBe(h.groups[1]!.group.id);
});
it('forged private group selection cannot enter another group', async () => {
  const h = make([], { groups: 0 });
  const foreign = d.ensureGroup(h.db, -999, 'Foreign', [{ telegramUserId: SAM.id, displayName: 'Sam' }]);
  await h.tap(`ag:g:${foreign.group.id}`, ANA, ANA.id); alert(h, 'That group is not available.'); expect(h.model.requests).toEqual([]);
});
it.each(['group', 'global', 'unavailable', 'private'])('sends the %s fallback with a Mini App launch', async kind => {
  const h = make(kind === 'unavailable' ? [new Error('private text')] : [text()], { config: kind === 'group' || kind === 'private' ? { agentDailyCap: 0 } : kind === 'global' ? { agentGlobalDailyCap: 1 } : {} });
  if (kind === 'global') d.reserveAgentMessage(h.db, h.groups[0]!.group.id, 100, NOW, 1);
  if (kind === 'private') await h.privateText('hi'); else await h.mention('hi');
  expect(h.sent().at(-1)?.text).toBe(kind === 'unavailable' ? AGENT_TEXT.unavailable : AGENT_TEXT.limit);
  const url = new URL(h.buttons()[0]!.url!);
  expect(decodeLaunch(url.searchParams.get('startapp')!, h.config.linkSecret).groupId).toBe(h.groups[0]!.group.id);
  expect(h.model.requests).toHaveLength(kind === 'unavailable' ? 1 : 0);
});
it.each([{ agentEnabled: false }, { agentEnabled: true }])('without a key/model sends one disabled reply: %j', async config => {
  const h = make([], { config, noModel: true }); await h.mention('hi');
  expect(h.sent()).toHaveLength(1); expect(h.sent()[0]?.text).toBe(AGENT_TEXT.off); expect(h.buttons()[0]?.url).toContain('startapp=');
  expect(h.db.prepare('SELECT * FROM agent_usage').all()).toEqual([]);
});
it('explicitly disabled ignores even an injected model; fallback private button can use web_app', async () => {
  const h = make([text()], { config: { agentEnabled: false, webhookUrl: 'https://trip.example', webhookSecret: 'test-webhook-secret' } });
  await h.privateText('hi'); expect(h.model.requests).toEqual([]); expect(h.buttons()).toEqual([{ text: 'Add expense', web_app: { url: 'https://trip.example' } }]);
});
it('purges expired conversations opportunistically even on a capped turn', async () => {
  const h = make([], { config: { agentDailyCap: 0 } }), g = h.groups[0]!;
  d.appendTurn(h.db, d.memberScope(g.group.id, g.members[0]!.id), CHAT, 'user', 'Old private text', new Date(NOW.getTime() - 30 * 60_000));
  await h.mention('hi'); expect(h.db.prepare("SELECT * FROM agent_turn WHERE role <> 'chosen_group'").all()).toEqual([]);
});
it('disabled fallback also passes tagged photos to receipts', async () => {
  const h = make([], { fallback: true, receiptAfter: true });
  await h.send('', { text: undefined, caption: `@${BOT_USERNAME}`, photo: [{ file_id: 'p', file_unique_id: 'p', width: 1, height: 1 }] });
  expect(h.readReceipt).toHaveBeenCalledOnce(); expect(h.sent().some(s => s.text === AGENT_TEXT.off)).toBe(false);
});
it('does not model disallowed groups or expose their private choices', async () => {
  const h = make([], { groups: 2, config: { allowedChatIds: [CHAT] } });
  await h.mention('hi', {}, ANA, CHAT - 1); expect(h.model.requests).toEqual([]);
  await h.send('/group', { entities: [{ type: 'bot_command', offset: 0, length: 6 }] }, ANA, ANA.id);
  expect(h.buttons().map(b => b.text)).toEqual(['Trip 0']);
});
it.each([CHAT, ANA.id])('/help in chat %s shows three examples and an app button, without a model call', async chatId => {
  const h = make(); await h.send('/help', { entities: [{ type: 'bot_command', offset: 0, length: 5 }] }, ANA, chatId);
  expect(h.sent().at(-1)?.text.split('\n')).toHaveLength(6);
  expect(h.sent().at(-1)?.text).toContain('taxi 24 dollars'); expect(h.sent().at(-1)?.text).toContain('who owes what?'); expect(h.sent().at(-1)?.text).toContain('I paid Sam 20 SGD');
  expect(h.sent().at(-1)?.text).toContain('Send me a photo of a receipt');
  expect(h.buttons()).toHaveLength(1); expect(h.model.requests).toEqual([]);
});
it('a changed expense record refuses confirmation without a notice', async () => {
  const h = make([calls(['delete_expense', { expenseId: 1 }]), text()]);
  const g = h.groups[0]!, scope = d.memberScope(g.group.id, g.members[0]!.id);
  const e = d.createExpense(h.db, scope, { tripId: g.trip!.id, status: 'confirmed', description: 'Taxi', payerId: g.members[0]!.id, expenseDate: '2026-09-28', total: 2400, currency: 'SGD', splitType: 'even', shares: [{ memberId: g.members[0]!.id }] });
  await h.mention('delete taxi'); const p = latest(h);
  d.saveExpense(h.db, scope, e.id, e.version, { description: 'Changed', payerId: e.payerId, expenseDate: e.expenseDate, total: 2500, splitType: 'even', shares: [{ memberId: e.payerId }] });
  await h.tap(proposalCallback('yes', p.id)); alert(h, 'This changed since I prepared it. Ask me again.');
  expect(d.getExpense(h.db, scope, e.id).status).toBe('confirmed'); expect(h.notifier.expenseDeleted).not.toHaveBeenCalled();
});
it('posts every part of a long summary before offering confirmation', async () => {
  // Item names are cut to 34 characters, so it takes many items to go past one message.
  const items = Array.from({ length: 150 }, () => ({ label: '🍜'.repeat(90), amount: '1', people: [{ name: 'everyone' }] }));
  const h = make([calls(['add_expense', { ...args, amount: '150', splitType: 'items', items }]), text()]);
  const id = await h.mention('dinner');
  expect(h.sent().length).toBeGreaterThan(1);
  expect(h.sent().map(p => p.text.replace(/<\/?b>/g, '')).join('\n\n').replace(/\n+/g, '\n')).toBe(latest(h).summary.replace(/\n+/g, '\n'));
  for (const sent of h.sent()) {
    expect(sent.text.length).toBeLessThanOrEqual(4000);
    expect(sent.text.isWellFormed()).toBe(true);
    expect(sent.parse_mode).toBe('HTML');
    expect((sent.text.match(/<b>/g) ?? []).length).toBe((sent.text.match(/<\/b>/g) ?? []).length);
    expect(sent.reply_parameters.message_id).toBe(id);
  }
  expect(h.sent().slice(0, -1).every(p => !p.reply_markup)).toBe(true);
  expect(h.buttons().map(b => b.text)).toEqual(['Approve', 'Change', 'Cancel']);
});
it('serializes concurrent confirmation taps so notices are handed off once', async () => {
  const h = make(proposalScript()); await h.mention('taxi'); const data = h.data('Approve');
  await Promise.all([h.tap(data), h.tap(data)]);
  expect(h.notifier.expenseSaved).toHaveBeenCalledOnce(); alert(h, 'Already done.');
});
it('rejects a proposal callback in another chat and a missing proposal', async () => {
  const h = make(proposalScript()); await h.mention('taxi'); const p = latest(h);
  await h.tap(proposalCallback('yes', p.id), ANA, ANA.id); alert(h, 'That offer does not exist.');
  await h.tap(proposalCallback('yes', '00000000-0000-0000-0000-000000000000')); alert(h, 'That offer does not exist.');
  expect(d.getProposal(h.db, p.id)!.status).toBe('pending'); expect(h.notifier.expenseSaved).not.toHaveBeenCalled();
});
it('expires private questions waiting for a group and never models them later', async () => {
  const h = make([], { groups: 2 }); await h.privateText('Old question');
  vi.setSystemTime(new Date(NOW.getTime() + 30 * 60_000));
  await h.tap(`ag:g:${h.groups[0]!.group.id}`, ANA, ANA.id);
  expect(h.model.requests).toEqual([]); expect(h.sent('editMessageText').at(-1)?.text).toContain('Using Trip 0');
});
it('private Change restores the proposal group after a selection switch', async () => {
  const h = make([...proposalScript(), calls(['add_expense', { ...args, amount: '30' }]), text()], { groups: 2 });
  await h.privateText('taxi'); await h.tap(`ag:g:${h.groups[0]!.group.id}`, ANA, ANA.id);
  const p = latest(h);
  await h.tap(`ag:g:${h.groups[1]!.group.id}`, ANA, ANA.id);
  await h.tap(proposalCallback('change', p.id), ANA, ANA.id);
  expect(d.chosenGroup(h.db, ANA.id, ANA.id)?.groupId).toBe(p.groupId);
  await h.privateText('make it 30'); expect(latest(h).groupId).toBe(p.groupId);
  expect(d.getProposal(h.db, p.id)!.status).toBe('cancelled');
});
it('/help stays available with chat disabled and uses a private web_app button', async () => {
  const h = make([], { config: { agentEnabled: false, webhookUrl: 'https://trip.example', webhookSecret: 'test-webhook-secret' } });
  await h.send('/help', { entities: [{ type: 'bot_command', offset: 0, length: 5 }] }, ANA, ANA.id);
  expect(h.sent().at(-1)?.text).toContain('who owes what?');
  expect(h.buttons()[0]?.web_app).toEqual({ url: 'https://trip.example' }); expect(h.model.requests).toEqual([]);
});

it.each([false, true])('private photo gets one receipt reply and no agent reply (receiptAfter=%s)', async receiptAfter => {
  const h = make([], { receiptAfter });
  await h.send('', { text: undefined, photo: [{ file_id: 'p', file_unique_id: 'p', width: 10, height: 10 }] }, ANA, ANA.id);
  expect(h.readReceipt).toHaveBeenCalledOnce(); expect(h.model.requests).toEqual([]);
  expect(h.sent().filter(p => p.chat_id === ANA.id)).toEqual([expect.objectContaining({ text: 'Reading receipt...' })]);
  expect(h.sent('editMessageText').filter(p => p.chat_id === ANA.id)).toHaveLength(1);
});
it('agent /group choice is used by receipts, and receipt choice is used by the agent', async () => {
  const h = make([text()], { groups: 2 });
  await h.send('', { text: undefined, photo: [{ file_id: 'p', file_unique_id: 'p', width: 10, height: 10 }] }, ANA, ANA.id);
  await h.tap(h.data('Trip 0'), ANA, ANA.id);
  await h.privateText('hello');
  expect(h.model.requests[0]!.trip.data).toMatchObject({ trip: { id: h.groups[0]!.trip!.id } });
  await h.send('/group', { entities: [{ type: 'bot_command', offset: 0, length: 6 }] }, ANA, ANA.id);
  await h.tap(h.data('Trip 1'), ANA, ANA.id);
  await h.send('', { text: undefined, document: { file_id: 'doc', file_unique_id: 'doc', mime_type: 'image/jpeg' } }, ANA, ANA.id);
  expect(h.sent('editMessageText').at(-1)?.text).toContain('For Trip 1');
  expect(h.model.requests).toHaveLength(1);
});
it('agent approval of a private receipt notifies its group once', async () => {
  const h = make([calls(['approve_draft', { expenseId: 1 }]), text()]);
  await h.send('', { text: undefined, photo: [{ file_id: 'p', file_unique_id: 'p', width: 10, height: 10 }] }, ANA, ANA.id);
  await h.privateText('approve the receipt'); const data = h.data('Approve');
  await h.tap(data, ANA, ANA.id); await h.tap(data, ANA, ANA.id);
  expect(h.notifier.expenseSaved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: CHAT, expenseId: 1 }));
});
it('sends model replies as plain text even when they contain HTML-looking text',async()=>{
  const h=make([text('<b>Tom & Jerry</b>')]);
  await h.mention('balances');
  expect(h.sent().at(-1)).toMatchObject({text:'<b>Tom & Jerry</b>'});
  expect(h.sent().at(-1)).not.toHaveProperty('parse_mode');
});
it('escapes a proposal and completion but stores the plain summary in the conversation',async()=>{
  const h=make([calls(['add_expense',{...args,description:'<b>Tom & Jerry</b>'}]),text()]);
  await h.mention('add it');
  expect(h.sent().at(-1)).toMatchObject({parse_mode:'HTML',text:expect.stringContaining('<b>➕ Add &lt;b&gt;Tom &amp; Jerry&lt;/b&gt;</b>')});
  const p=latest(h);
  expect(p.summary).toContain('➕ Add <b>Tom & Jerry</b>');
  expect(d.recentTurns(h.db,d.memberScope(p.groupId,p.memberId),CHAT,NOW).at(-1)?.content).toBe(p.summary);
  await h.tap(proposalCallback('yes',p.id));
  expect(h.sent('editMessageText').at(-1)).toMatchObject({parse_mode:'HTML',text:'✅ Added &lt;b&gt;Tom &amp; Jerry&lt;/b&gt; · 24.00 SGD'});
});
