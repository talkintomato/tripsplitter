import { z } from 'zod';
import { defineTool, id, amount, plan, refuse, quotedName } from './shared.js';
import { getSettlement, getTrip } from '../../db/index.js';
import { formatAmount } from '../../core/index.js';
export default defineTool('undo_payment','Undo a recorded payment.',z.strictObject({settlementId:id}),(c,a)=>{const s=getSettlement(c.db,c.scope,a.settlementId);if(s.status!=='active')refuse('This payment was already undone.');const t=getTrip(c.db,c.scope,s.tripId);return plan({kind:'undo_payment',settlementId:s.id},`Undo payment #${s.id}: ${quotedName(c,s.fromMemberId)} paid ${quotedName(c,s.toMemberId)} ${formatAmount(s.amount,t.homeCurrency)}.`,'Undo it');});
