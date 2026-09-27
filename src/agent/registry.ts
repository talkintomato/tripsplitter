import { z } from 'zod';
import { type ToolDefinition } from './model.js';
import type { ToolContext, ToolOutcome } from './types.js';
import get_trip from './tools/get_trip.js';
import list_members from './tools/list_members.js';
import resolve_members from './tools/resolve_members.js';
import list_expenses from './tools/list_expenses.js';
import get_expense from './tools/get_expense.js';
import get_balances from './tools/get_balances.js';
import list_settlements from './tools/list_settlements.js';
import get_activity from './tools/get_activity.js';
import preview_expense from './tools/preview_expense.js';
import add_expense from './tools/add_expense.js';
import edit_expense from './tools/edit_expense.js';
import approve_draft from './tools/approve_draft.js';
import set_expense_rate from './tools/set_expense_rate.js';
import record_payment from './tools/record_payment.js';
import undo_payment from './tools/undo_payment.js';
import add_member from './tools/add_member.js';
import set_trip_rate from './tools/set_trip_rate.js';
import rename_trip from './tools/rename_trip.js';
import end_trip from './tools/end_trip.js';
import reopen_trip from './tools/reopen_trip.js';
import discard_draft from './tools/discard_draft.js';
import delete_expense from './tools/delete_expense.js';
import restore_expense from './tools/restore_expense.js';

export const registry = [get_trip, list_members, resolve_members, list_expenses, get_expense, get_balances, list_settlements, get_activity, preview_expense, add_expense, edit_expense, approve_draft, set_expense_rate, record_payment, undo_payment, add_member, set_trip_rate, rename_trip, end_trip, reopen_trip, discard_draft, delete_expense, restore_expense] as const;
export const toolDefinitions: ToolDefinition[] = registry.map(t=>({name:t.name,description:t.description,parameters:z.toJSONSchema(t.schema) as Record<string,unknown>}));
export async function runTool(context:ToolContext,name:string,args:unknown):Promise<ToolOutcome> {
 const tool=registry.find(t=>t.name===name);
 if(!tool) throw new Error('That tool is not available.');
 return tool.execute(context,args);
}
