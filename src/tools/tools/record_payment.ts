import { displayAmount } from '../summary.js';
import { z } from 'zod';
import { defineTool, id, name, currency, amount, plan, trip, refuse, person, people, memberName } from './shared.js';
import { toMinorUnits } from '../../core/index.js';
export default defineTool('record_payment','Record a payment in the trip home currency.',z.strictObject({tripId:id.optional(),from:name,to:name,amount,currency}),(c,a)=>{const t=trip(c,a.tripId);if(a.currency!==t.homeCurrency)refuse(`Record the payment in ${t.homeCurrency}.`);const value=toMinorUnits(a.amount,a.currency);if(value<=0)refuse('The payment must be more than zero.');const from=person(c,a.from),to=person(c,a.to);if(from===to)refuse('A payment needs two different people.');return plan({kind:'record_payment',tripId:t.id,fromMemberId:from,toMemberId:to,amount:value},{icon:'💸',title:`Payment · ${memberName(c,from)} → ${memberName(c,to)}`,blocks:[{lines:[{label:'Amount',value:displayAmount(value,t.homeCurrency)}]}]},'Record it');});
