import { z } from 'zod';
import { defineTool, id, name, plan, trip, refuse } from './shared.js';
import { getActiveTrip } from '../../db/index.js';
export default defineTool('reopen_trip','Reopen an ended trip when the group has no active trip.',z.strictObject({tripId:id.optional()}),(c,a)=>{const t=trip(c,a.tripId);if(t.status!=='ended')refuse('This trip is already active.');if(getActiveTrip(c.db,c.scope))refuse('This group has another active trip. End that one first.');return plan({kind:'reopen_trip',tripId:t.id},`Reopen trip ${JSON.stringify(t.name)}. Expenses and rates can be changed again.`,'Reopen trip');});
