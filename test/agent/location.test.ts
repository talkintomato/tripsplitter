import { expect, it } from 'vitest';
import { confirmProposal, runTool } from '../../src/agent/index.js';
import { getExpense } from '../../src/db/index.js';
import { expense, fixture, now, prepare } from './helpers.js';

it('get_expense exposes the place name and confirmed agent edits preserve location', async () => {
  const f = fixture();
  try {
    const location = { locationLat: 35.6595, locationLng: 139.7005, placeName: 'Shibuya', locationSource: 'photo' as const };
    const e = expense(f, 'confirmed', location);
    const read = await runTool(f.context, 'get_expense', { expenseId: e.id });
    expect(read).toMatchObject({ kind: 'read', data: { expense: location } });
    const { p } = await prepare(f, 'edit_expense', { expenseId: e.id, changes: { description: 'Changed' } });
    expect(confirmProposal(f.db, {}, { proposalId: p.id, memberId: f.member.id, now }).kind).toBe('done');
    expect(getExpense(f.db, f.scope, e.id)).toMatchObject({ ...location, description: 'Changed', version: 2 });
  } finally { f.db.close(); }
});
