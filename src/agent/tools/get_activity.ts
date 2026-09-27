import { z } from 'zod';
import { defineTool, id, read } from './shared.js';
import { listActivity } from '../../db/index.js';
export default defineTool('get_activity','Recent group activity, optionally for an expense.',z.strictObject({expenseId:id.optional(),limit:z.number().int().min(1).max(50).optional()}),(c,a)=>read(listActivity(c.db,c.scope,{limit:a.limit??20,...(a.expenseId?{entity:{type:'expense',id:a.expenseId}}:{})})));
