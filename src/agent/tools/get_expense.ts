import { z } from 'zod';
import { defineTool, id, read } from './shared.js';
import { getExpense, getTrip } from '../../db/index.js';
import { validateExpense, computeShares, amountsToRecord } from '../../core/index.js';
export default defineTool('get_expense','One expense, items, shares and calculated amounts; invalid drafts return problems.',z.strictObject({expenseId:id}),(c,a)=>{
 const e=getExpense(c.db,c.scope,a.expenseId);const problems=validateExpense(e,e.items,e.shares);
 return read({expense:e,problems,amounts:problems.length?null:amountsToRecord(computeShares(e,e.items,e.shares))});
});
