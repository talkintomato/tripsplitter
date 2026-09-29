import { defineTool, id, rate, newExpenseFields, read, trip, withNewExpenseDefaults } from './shared.js';
import { prepareExpense } from './expensePlan.js';
export default defineTool('preview_expense','Preview a complete expense without saving or proposing.',newExpenseFields.extend({tripId:id.optional()}),async(c,a)=>{const t=trip(c,a.tripId);const p=await prepareExpense(c,t.id,withNewExpenseDefaults(c,t,a));return read({summary:p.summary,preview:p.preview,rate:p.rate,suggestedChanges:p.plans.map(p=>p.summary)});});
