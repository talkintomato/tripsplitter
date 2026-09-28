import { z } from 'zod';
import { defineTool, id, rate, trip } from './shared.js';
import { changeExpense } from './expensePlan.js';
export default defineTool('set_expense_rate','Set an expense rate; null clears the override and follows the trip rate.',z.strictObject({expenseId:id,rate:rate.nullable()}),(c,a)=>changeExpense(c,'set_expense_rate',a.expenseId,{rateOverride:a.rate}));
