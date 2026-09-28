import { defineTool, id, rate, expenseFields, read, trip } from './shared.js';
import { prepareExpense } from './expensePlan.js';
export default defineTool('preview_expense','Preview a complete expense without saving or proposing.',expenseFields.extend({tripId:id.optional()}),async(c,a)=>{const p=await prepareExpense(c,trip(c,a.tripId).id,a);return read({summary:p.summary,preview:p.preview,rate:p.rate,suggestedChanges:p.plans.map(p=>p.summary)});});
