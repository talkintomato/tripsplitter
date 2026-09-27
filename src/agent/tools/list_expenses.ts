import { z } from 'zod';
import { defineTool, id, name, date, read, trip, person } from './shared.js';
import { listExpenses } from '../../db/index.js';
export default defineTool('list_expenses','Newest expenses, at most 20; dates inclusive.',z.strictObject({tripId:id.optional(),status:z.enum(['draft','confirmed','deleted','discarded']).optional(),from:date.optional(),to:date.optional(),payer:name.optional(),text:z.string().max(500).optional()}),(c,a)=>{
 const payer=a.payer===undefined?undefined:person(c,a.payer);
 return read(listExpenses(c.db,c.scope,trip(c,a.tripId).id,{status:a.status}).filter(e=>(!a.from||e.expenseDate>=a.from)&&(!a.to||e.expenseDate<=a.to)&&(payer===undefined||e.payerId===payer)&&(!a.text||`${e.description} ${e.merchant??''}`.toLocaleLowerCase().includes(a.text.toLocaleLowerCase()))).slice(0,20));
});
