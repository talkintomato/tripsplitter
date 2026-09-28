import { displayAmount } from '../summary.js';
import { z } from 'zod';
import { defineTool, id, amount, plan, refuse, memberName } from './shared.js';
import { getSettlement, getTrip } from '../../db/index.js';

export default defineTool('undo_payment','Undo a recorded payment.',z.strictObject({settlementId:id}),(c,a)=>{const s=getSettlement(c.db,c.scope,a.settlementId);if(s.status!=='active')refuse('This payment was already undone.');const t=getTrip(c.db,c.scope,s.tripId);return plan({kind:'undo_payment',settlementId:s.id},{icon:'↩️',title:`Undo payment · ${memberName(c,s.fromMemberId)} → ${memberName(c,s.toMemberId)}`,blocks:[{lines:[{label:'Amount',value:displayAmount(s.amount,t.homeCurrency)}]}]},'Undo it');});
