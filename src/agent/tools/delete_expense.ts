import { z } from 'zod';
import { defineTool, id, plan, trip, openTrip, refuse } from './shared.js';
import { getExpense } from '../../db/index.js';
import { removalSummary } from './expensePlan.js';
export default defineTool('delete_expense','Delete expense.',z.strictObject({expenseId:id}),(c,a)=>{const e=getExpense(c.db,c.scope,a.expenseId);openTrip(trip(c,e.tripId));if(!["confirmed"].includes(e.status))refuse('This expense is not in the required status.');return plan({kind:'delete_expense',expenseId:e.id},removalSummary(c,'Delete expense',e)+'\nWarning: deleting this expense removes it from balances. It can be restored.','Delete it');});
