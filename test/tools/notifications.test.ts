import { afterEach, expect, it } from 'vitest';
import { confirmProposal } from '../../src/tools/index.js';
import { setTripRate } from '../../src/db/index.js';
import { fixture, prepare, expense, expenseArgs, now, type Fixture } from '../agent/helpers.js';
const opened: Fixture[] = [];
afterEach(() => opened.splice(0).forEach(f => f.db.close()));
function setup() { const f = fixture(); opened.push(f); return f; }
it.each(['add', 'approve', 'edit'])('shared command, agent and MCP %s payloads preserve recipient IDs and foundation amounts', async kind => {
  const f = setup();
  const e = kind === 'add' ? null : expense(f, kind === 'approve' ? 'draft' : 'confirmed');
  const tool = kind === 'add' ? 'add_expense' : kind === 'approve' ? 'approve_draft' : 'edit_expense';
  const args = kind === 'add' ? expenseArgs : kind === 'approve' ? { expenseId: e!.id } : { expenseId: e!.id, changes: { amount: '14' } };
  const { p } = await prepare(f, tool, args);
  const result = confirmProposal(f.db, {}, { proposalId: p.id, memberId: f.member.id, now });
  expect(result.kind).toBe('done');
  if (result.kind !== 'done') throw Error('Expected successful mutation');
  const n = result.notices[0]!;
  expect(n.payload).toMatchObject({ groupId: f.g.group.id, personal: {
    actorMemberId: f.member.id, payerId: f.member.id, tripId: f.trip.id, tripName: f.trip.name,
    memberIds: [f.member.id, f.alex.id], homeCurrency: 'SGD', balances: { [f.member.id]: kind === 'edit' ? 700 : 600, [f.alex.id]: kind === 'edit' ? -700 : -600 },
  } });
  if (kind === 'edit') expect(n.payload).toMatchObject({ beforePersonal: { balances: { [f.member.id]: 600, [f.alex.id]: -600 } } });
});
it('shared payment payloads identify actor and both parties', async () => {
  const f = setup();
  const { p } = await prepare(f, 'record_payment', { from: 'me', to: 'Alex', amount: '12', currency: 'SGD' });
  const result = confirmProposal(f.db, {}, { proposalId: p.id, memberId: f.member.id, now });
  expect(result).toMatchObject({ kind: 'done', notices: [{ method: 'settlementRecorded', payload: { actorMemberId: f.member.id, fromMemberId: f.member.id, toMemberId: f.alex.id, groupId: f.g.group.id, tripId: f.trip.id } }] });
});
it('shared rate payloads select only balances changed by the rate', async () => {
  const f = setup();
  setTripRate(f.db, f.scope, f.trip.id, 'JPY', '100', 'member');
  expense(f, 'confirmed', { currency: 'JPY', total: 1200 });
  const { p } = await prepare(f, 'set_trip_rate', { currency: 'JPY', rate: '120' });
  const result = confirmProposal(f.db, {}, { proposalId: p.id, memberId: f.member.id, now });
  expect(result).toMatchObject({ kind: 'done', notices: [{ method: 'tripRateChanged', payload: { actorMemberId: f.member.id, affectedMemberIds: [f.member.id, f.alex.id], groupId: f.g.group.id, tripId: f.trip.id } }] });
});
