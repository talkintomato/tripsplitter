import { defineTool, id, expenseFields, trip } from './shared.js';
import { prepareExpense } from './expensePlan.js';
export default defineTool('add_expense','Propose a confirmed expense; drafts cannot be created.',expenseFields.extend({tripId:id.optional()}),async(c,a)=>{const t=trip(c,a.tripId);const p=await prepareExpense(c,t.id,a);return {kind:'proposal',plans:[...p.plans,{action:{kind:'add_expense',tripId:t.id,input:p.input},summary:`Add expense\n${p.summary}`,confirmLabel:'Add it'}]};});
