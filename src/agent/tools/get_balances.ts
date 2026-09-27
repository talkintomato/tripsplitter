import { z } from 'zod';
import { defineTool, id, currency, amount, read, trip } from './shared.js';
import { getTripBalances } from '../../db/index.js';
import { formatAmount } from '../../core/index.js';
export default defineTool('get_balances','Foundation balances and suggested payments in home currency.',z.strictObject({tripId:id.optional()}),(c,a)=>{
 const result=getTripBalances(c.db,c.scope,trip(c,a.tripId).id);
 return read({...result,formattedBalances:Object.fromEntries(Object.entries(result.balances).map(([id,value])=>[id,formatAmount(value,result.trip.homeCurrency)])),payments:result.payments.map(p=>({...p,formattedAmount:formatAmount(p.amount,result.trip.homeCurrency)}))});
});
