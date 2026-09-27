import { z } from 'zod';
import { defineTool, id, expenseFields } from './shared.js';
import { changeExpense } from './expensePlan.js';
export default defineTool('approve_draft','Approve a receipt draft, optionally changing fields.',z.strictObject({expenseId:id,changes:expenseFields.partial().optional()}),(c,a)=>changeExpense(c,'approve_draft',a.expenseId,a.changes??{}));
