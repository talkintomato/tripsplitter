import { z } from 'zod';
import { defineTool, id, expenseFields } from './shared.js';
import { changeExpense } from './expensePlan.js';
export default defineTool('edit_expense','Propose partial changes to an existing expense, preserving other fields.',z.strictObject({expenseId:id,changes:expenseFields.partial()}),(c,a)=>changeExpense(c,'edit_expense',a.expenseId,a.changes));
