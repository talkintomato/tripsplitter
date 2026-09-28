import { z } from 'zod';
import { defineTool, id, plan, trip, openTrip, refuse } from './shared.js';
import { getExpense } from '../../db/index.js';
import { removalSummary } from './expensePlan.js';
export default defineTool('discard_draft','Discard draft.',z.strictObject({expenseId:id}),(c,a)=>{const e=getExpense(c.db,c.scope,a.expenseId);openTrip(trip(c,e.tripId));if(!["draft"].includes(e.status))refuse('This expense is not in the required status.');return plan({kind:'discard_draft',expenseId:e.id},removalSummary(c,'Discard',e),'Discard it');});
