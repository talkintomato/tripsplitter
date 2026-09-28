import { z } from 'zod';
import { defineTool, id, plan, trip, openTrip, refuse, expenseAmounts, inputOf } from './shared.js';
import { getExpense } from '../../db/index.js';
import { removalSummary } from './expensePlan.js';
export default defineTool('restore_expense','Restore expense.',z.strictObject({expenseId:id}),(c,a)=>{const e=getExpense(c.db,c.scope,a.expenseId);openTrip(trip(c,e.tripId));if(!["deleted", "discarded"].includes(e.status))refuse('This expense is not in the required status.');if(e.status==='deleted') expenseAmounts(c,inputOf(e),trip(c,e.tripId),e.fxRate);return plan({kind:'restore_expense',expenseId:e.id},removalSummary(c,'Restore',e),'Restore it');});
